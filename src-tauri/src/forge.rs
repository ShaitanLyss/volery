//! The rows a forge answers in, and nothing about any particular forge.
//!
//! This file exists because there are two of them now. `azdo.rs` held these
//! types for as long as Azure DevOps was the only thing the wall could see, and
//! that was the right place for them right up until `github.rs` needed to build
//! the same row — at which point leaving them there would have made one forge
//! the owner and the other a guest, which is exactly the shape `devops.svelte.ts`
//! avoided on the front end by being named for the class rather than for either
//! widget.
//!
//! **Every field here is a fact, and the forge's own word for it.** A `status`
//! is whatever the service called it — `inProgress` from Azure DevOps,
//! `in_progress` from GitHub — and nothing in Rust folds one vocabulary into the
//! other. What a status *means*, what colour it is and how it is worded are
//! `azdo.ts`'s, which is pure and tested, and which dispatches on `forge` for
//! exactly the states the two services disagree about.
//!
//! That is a rule with one deliberate exception and the line between them is
//! worth stating, because it is the line every future forge will be argued
//! against:
//!
//! **A projection is honest where it is total and lossless; it is a lie where
//! the second forge has states the first has no word for.** `merge` is projected
//! in `github.rs` — GitHub's `MERGEABLE`/`CONFLICTING`/`UNKNOWN` correspond
//! exactly to Azure DevOps' `succeeded`/`conflicts`/`queued`, three states to
//! three states, with nothing left over and nothing invented. A run's
//! `conclusion` is **not** projected, because GitHub has nine of them and Azure
//! DevOps has four: `timedOut`, `actionRequired` and `startupFailure` have no
//! Azure DevOps spelling at all, and `actionRequired` — a workflow parked
//! waiting for somebody to approve a deployment — is the single most interesting
//! row this widget can draw. Folding it into `failed` would throw away the one
//! state the wall's amber was made for.

use serde::Serialize;

/// Which service a row came off.
///
/// Carried on the row rather than inferred from anything about it. It could be
/// read out of the url or the shape of an id, and both would work today and
/// break the first time a third forge wrote a url like one of these two. It is
/// the discriminator `azdo.ts` switches on, so it is worth one string.
#[derive(Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Forge {
    Azdo,
    Github,
}

impl Forge {
    /// The word the front end sees, and the one `azdo.ts` matches on.
    pub fn as_str(self) -> &'static str {
        match self {
            Forge::Azdo => "azdo",
            Forge::Github => "github",
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    /// Stable across polls and unique across forges *and* organisations, so the
    /// front end can key a list on it without a second thought — and so that
    /// asking for one run's detail needs nothing but this string.
    pub(crate) id: String,
    pub(crate) forge: &'static str,
    /// The organisation on Azure DevOps, the owner on GitHub. Both answer the
    /// same question — whose account is this under — and the widget prints it
    /// in the same place.
    pub(crate) org: String,
    /// The Azure DevOps project, or the GitHub repository. Not the same kind of
    /// thing, and the widget's `lanes` reading groups by it either way: what a
    /// person wants is the coarsest grouping the forge offers under the org,
    /// which is what each of these is.
    pub(crate) project: String,
    /// The build definition, or the workflow. Verbatim.
    pub(crate) pipeline: String,
    /// Azure DevOps composes one (`20260814.3`); GitHub counts (`36`). Printed,
    /// never parsed.
    pub(crate) number: String,
    /// Azure DevOps: `notStarted` | `inProgress` | `completed` | `cancelling` |
    /// `postponed`. GitHub: `queued` | `in_progress` | `completed` | `waiting` |
    /// `requested` | `pending`. Two vocabularies, both verbatim — see the note
    /// at the top of this file about why neither is folded into the other.
    pub(crate) status: String,
    /// Azure DevOps: `succeeded` | `partiallySucceeded` | `failed` | `canceled`.
    /// GitHub: `success` | `failure` | `cancelled` | `skipped` | `timed_out` |
    /// `action_required` | `neutral` | `stale` | `startup_failure`. Empty while
    /// it is still going, on both.
    pub(crate) result: String,
    /// Azure DevOps gives `refs/heads/main`; GitHub gives a bare `main`.
    /// Verbatim from each, and `shortRef` copes with both — see the note there
    /// about the one thing GitHub's shape loses.
    pub(crate) branch: String,
    pub(crate) by: String,
    pub(crate) queued_at: i64,
    pub(crate) started_at: i64,
    pub(crate) finished_at: i64,
    /// Where this run lives on the web, for the one gesture that leaves the app.
    pub(crate) url: String,
    /// Whether the caller is the one who asked for it.
    pub(crate) mine: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Vote {
    pub(crate) by: String,
    /// Azure DevOps' own scale: 10 approved, 5 approved with suggestions, 0 no
    /// vote, -5 waiting for the author, -10 rejected.
    ///
    /// **GitHub is projected onto it, and this is the second exception to the
    /// no-folding rule.** It qualifies under the same test: a five-point
    /// approval scale is not knowledge about a forge, it is the same fact both
    /// services report, and every GitHub review state has a place on it with
    /// nothing invented — `APPROVED` is 10, `CHANGES_REQUESTED` is -5,
    /// `COMMENTED` and `DISMISSED` are 0. See `github.rs` for why
    /// `CHANGES_REQUESTED` is the *author's turn* rather than a rejection.
    pub(crate) vote: i64,
    /// Whether this reviewer's approval is required for the pull request to
    /// land. Azure DevOps says so per reviewer; GitHub does not say at all, and
    /// answers the rolled-up question instead — see `Review::decision`.
    pub(crate) required: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub(crate) id: String,
    pub(crate) forge: &'static str,
    pub(crate) org: String,
    pub(crate) project: String,
    pub(crate) repo: String,
    pub(crate) number: i64,
    pub(crate) title: String,
    pub(crate) by: String,
    pub(crate) draft: bool,
    /// `succeeded` | `conflicts` | `queued` | `rejectedByPolicy` | `notSet`.
    /// Azure DevOps' vocabulary, and GitHub's three states are projected onto
    /// its first three — see the note at the top of this file.
    pub(crate) merge: String,
    /// The branch it wants to land on. `refs/heads/main` from Azure DevOps, a
    /// bare `main` from GitHub, as with `Run::branch`.
    pub(crate) target: String,
    pub(crate) created_at: i64,
    pub(crate) url: String,
    /// Set to complete itself once its policies pass — so it is waiting on a
    /// build rather than on a person, which is a different row to draw.
    pub(crate) auto: bool,
    pub(crate) mine: bool,
    /// Whether the caller is on it as a reviewer, and what they have said. Both,
    /// because "asked and has not answered" and "not asked" are different states
    /// that a vote of 0 cannot tell apart on its own.
    pub(crate) reviewing: bool,
    pub(crate) my_vote: i64,
    pub(crate) votes: Vec<Vote>,
    /// The forge's own rolled-up answer to "as far as review goes, can this
    /// land": `approved` | `changesRequested` | `reviewRequired`, or empty when
    /// the forge does not answer it.
    ///
    /// **Empty for Azure DevOps, and that is not a gap.** Azure DevOps marks
    /// each reviewer required or not, so the question is answerable from the
    /// votes and `landable` computes it. GitHub does the opposite — it will not
    /// tell you who is required, and answers the rollup instead. Two forges,
    /// two halves of the same fact, and neither can be derived from the other,
    /// so both are carried and `landable` dispatches.
    pub(crate) decision: String,
}

/* ── one run, opened ───────────────────────────────────────────────────────
 *
 * The other half of what this widget is for. A row says a build failed; this
 * says which job, and which step of it.
 *
 * **Two levels, on both forges, and that is a decision rather than the shape
 * either one hands over.** GitHub gives exactly two — jobs, each with steps.
 * Azure DevOps gives four, as a flat list of records with parent pointers:
 * Stage → Phase → Job → Task. Probed 2026-08-27 against a RISE build, 71
 * records for a pipeline of six stages.
 *
 * The unit both services agree on is the one that runs on an agent and owns a
 * log — Azure DevOps' `Job`, GitHub's job — so that is a `Stage` here, and the
 * leaf below it is a `Step`. Azure DevOps' `Phase` is a one-to-one wrapper
 * around its Job in every pipeline probed and is dropped; its `Stage` is real
 * grouping and survives as a prefix on the job's name, so a six-stage pipeline
 * still reads as one. `Checkpoint` records are dropped outright — they are the
 * approval gate's bookkeeping, not work.
 *
 * The alternative was a tree of arbitrary depth, faithful to Azure DevOps and
 * padded on GitHub. It was declined for the reason the widget exists: this is
 * read at a glance in a panel, and a reading whose indentation depends on which
 * forge answered is one you have to decode before you can use it.
 */

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub(crate) name: String,
    /// The same two vocabularies as `Run`, and for the same reason. Azure
    /// DevOps' timeline says `pending` | `inProgress` | `completed`; GitHub's
    /// steps say `queued` | `in_progress` | `completed` | `pending`.
    pub(crate) status: String,
    /// Azure DevOps: `succeeded` | `succeededWithIssues` | `failed` |
    /// `canceled` | `skipped` | `abandoned`. Note `succeededWithIssues`, which
    /// is the timeline's spelling of the thing a *build* calls
    /// `partiallySucceeded` — the same service, two words, and both are carried
    /// verbatim rather than one being corrected into the other.
    pub(crate) result: String,
    pub(crate) started_at: i64,
    pub(crate) finished_at: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Stage {
    pub(crate) name: String,
    pub(crate) status: String,
    pub(crate) result: String,
    pub(crate) started_at: i64,
    pub(crate) finished_at: i64,
    pub(crate) steps: Vec<Step>,
}

/// One run's insides, as far as this app goes.
///
/// `fault` sits beside the stages rather than replacing them for the reason it
/// does on a list: a refresh that fails over a detail already on screen must
/// leave what is there.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Detail {
    pub(crate) id: String,
    pub(crate) forge: &'static str,
    pub(crate) stages: Vec<Stage>,
    /// Whether the run was still going when this reading was taken.
    ///
    /// Answered by Rust rather than re-derived on the front end from the stages,
    /// because a run whose last job has finished is *not* necessarily finished —
    /// Azure DevOps leaves a gap between the last task completing and the build
    /// being marked done, and a panel that stopped refreshing in that gap would
    /// show a run permanently one step from the end.
    pub(crate) live: bool,
    pub(crate) fault: Option<String>,
}

/* ── the one http client ───────────────────────────────────────────────────
 *
 * Shared rather than one per provider, because the reason it is built this way
 * is the network rather than the service. This network intercepts TLS —
 * `dev.azure.com` here presents a certificate issued by
 * `ca.macquarietelecom-103950.au.goskope.com`, Netskope, whose root is in
 * Windows' own store and in no bundled root set — so `ureq` is built with
 * `native-certs`. Built the obvious way instead, every request fails with a
 * certificate error here and works perfectly on the developer's home wifi,
 * which is the worst shape a bug can have. Confirmed 2026-08-27 that
 * `api.github.com` resolves through the same proxy, so the second forge
 * inherits the requirement rather than escaping it.
 *
 * Duplicating this per provider would mean two places to be wrong about a
 * corporate proxy, and the second one would be wrong for months before anybody
 * took the app off this network to find out. */

pub(crate) const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
pub(crate) const READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// The roots every outbound HTTPS call in this app trusts: **the bundled set
/// and the machine's, together**, because on this network neither alone is
/// enough.
///
/// This began as `ureq`'s `native-certs` feature and nothing else, on the
/// argument in `Cargo.toml`: rustls' default roots are a bundled copy of
/// Mozilla's, which cannot contain the corporate CA that actually signs what
/// arrives through Netskope interception. That argument is correct and it is
/// half the story. The other half, measured 2026-08-28:
///
/// ```text
/// rustls_native_certs::load_native_certs() -> 1 root
///   DigiCert Global Root G2   present: no
///   Netskope                  present: YES
/// ```
///
/// **One.** Out of forty-five in the store. `rustls-native-certs`' Windows
/// loader keeps a root only if it is marked valid for server auth —
///
/// ```ignore
/// match uses {
///     ValidUses::All => true,
///     ValidUses::Oids(strs) => strs.iter().any(|x| x == PKIX_SERVER_AUTH),
/// }
/// ```
///
/// — and this machine's policy has EKU-restricted the built-in roots so that
/// only Netskope's survives. Read charitably that is the enterprise saying "TLS
/// goes through us"; the trouble is that Netskope passes some domains through
/// *undecrypted*, and those then present a genuine public chain to a client that
/// has been left trusting one private CA.
///
/// So the app could reach exactly the hosts that were being intercepted.
/// `dev.azure.com` and `api.github.com` worked and looked like proof the
/// arrangement was sound; every `*.spotify.com` host failed with
/// `UnknownIssuer` against an ordinary DigiCert chain. It presented as a Spotify
/// bug for hours and was never about Spotify.
///
/// Merging is the fix and it is what the two halves were each reaching for:
/// 121 bundled + 1 native = 122, after which `api.spotify.com`,
/// `accounts.spotify.com`, `api.github.com` and `dev.azure.com` all complete a
/// handshake. Note the direction of the risk — this *widens* trust past what the
/// machine's policy states, to the same Mozilla set every browser and every
/// default rustls build already trusts. A client that trusts one interception CA
/// and nothing else is not more secure, it is merely unable to talk to anything
/// that CA has not touched.
///
/// `ureq::rustls` rather than a `rustls` of our own, so the version can never
/// drift from the one `ureq` is built against — a mismatch there is a type error
/// with a very long message about two `ClientConfig`s that look identical.
fn tls() -> std::sync::Arc<ureq::rustls::ClientConfig> {
    use std::sync::{Arc, OnceLock};
    static HELD: OnceLock<Arc<ureq::rustls::ClientConfig>> = OnceLock::new();

    HELD.get_or_init(|| {
        let mut roots = ureq::rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        /* Best effort, and deliberately not fatal: a machine with no readable
           store still has the bundled set, which is a working app everywhere
           that is not behind an interception proxy. Failing here would turn a
           policy quirk into an app that cannot reach anything. */
        if let Ok(native) = rustls_native_certs::load_native_certs() {
            for cert in native {
                let _ = roots.add(cert);
            }
        }
        Arc::new(
            ureq::rustls::ClientConfig::builder()
                .with_root_certificates(roots)
                .with_no_client_auth(),
        )
    })
    .clone()
}

pub(crate) fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(CONNECT_TIMEOUT)
        .timeout_read(READ_TIMEOUT)
        .tls_config(tls())
        .build()
}

/// The same roots, for a caller that wants its own timeouts. `update.rs` is the
/// one — it talks to GitHub on a different clock and must not inherit a forge's.
pub(crate) fn tls_config() -> std::sync::Arc<ureq::rustls::ClientConfig> {
    tls()
}

/* ── small shared readers ──────────────────────────────────────────────────*/

pub(crate) fn text(v: &serde_json::Value, key: &str) -> String {
    v.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string()
}

/// An ISO 8601 stamp as milliseconds since the epoch, or 0.
///
/// Both services write the same shape (`2026-08-27T02:07:24Z`), and a stamp
/// that will not parse is a zero rather than an error: a queued build genuinely
/// has no start time, and a step that has not run has neither.
pub(crate) fn epoch_ms(ts: &str) -> i64 {
    let n = |a: usize, z: usize| -> Option<i64> { ts.get(a..z)?.parse().ok() };
    let parse = || -> Option<i64> {
        let (y, mo, d) = (n(0, 4)?, n(5, 7)?, n(8, 10)?);
        let (h, mi, s) = (n(11, 13)?, n(14, 16)?, n(17, 19)?);
        if !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
            return None;
        }
        /* Fractional seconds when they are there, ignored when they are not.
           Azure DevOps writes them, GitHub does not, and neither is worth a
           branch anywhere else. */
        let ms = ts
            .get(19..)
            .filter(|r| r.starts_with('.'))
            .and_then(|r| r.get(1..4))
            .and_then(|f| f.parse::<i64>().ok())
            .unwrap_or(0);
        let days = days_from_civil(y, mo, d);
        Some(((days * 86_400 + h * 3_600 + mi * 60 + s) * 1_000) + ms)
    };
    parse().unwrap_or(0)
}

pub(crate) fn stamp(v: &serde_json::Value, key: &str) -> i64 {
    v.get(key).and_then(|v| v.as_str()).map(epoch_ms).unwrap_or(0)
}

/// Howard Hinnant's `days_from_civil`, which is the shortest correct answer to
/// "what day number is this date" and has no leap-year special case in it.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Percent-encoding, for putting a name into a url path. Only the characters
/// that would change the shape of the request; an Azure DevOps project called
/// `TX Development Squad` is the case this exists for, and a GitHub repository
/// name never needs it.
pub(crate) fn encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => out.push(c),
            _ => {
                let mut buf = [0u8; 4];
                for b in c.encode_utf8(&mut buf).as_bytes() {
                    out.push_str(&format!("%{b:02X}"));
                }
            }
        }
    }
    out
}

/// A GUI app spawning a console program flashes a black window unless it says
/// not to, and both providers shell out on a poll. The same `quiet` as
/// `project.rs`.
#[cfg(windows)]
pub(crate) fn quiet(cmd: &mut std::process::Command) -> &mut std::process::Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW)
}
#[cfg(not(windows))]
pub(crate) fn quiet(cmd: &mut std::process::Command) -> &mut std::process::Command {
    cmd
}

pub(crate) fn output(cmd: &mut std::process::Command) -> Option<String> {
    let out = quiet(cmd).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The remote a project root points at, or None.
///
/// One place, because two providers now ask the same question of the same
/// directory and each then decides whether the answer is theirs. Caching is the
/// caller's — each provider holds its own map, which costs one extra `git`
/// spawn per root per five minutes and is bought with not threading a third
/// mutex through both of them.
///
/// **`GIT_TERMINAL_PROMPT=0` and `credential.interactive=false`**, because this
/// runs on a poll and a background poll must never ask a question. `remote
/// get-url` does not authenticate today, and the cost of it being wrong once is
/// a credential window opening over the wall from something nobody asked for.
pub(crate) fn remote_of(root: &str) -> Option<String> {
    if !std::path::Path::new(root).is_dir() {
        return None;
    }
    output(
        std::process::Command::new("git")
            .current_dir(root)
            .env("GIT_TERMINAL_PROMPT", "0")
            .args(["-c", "credential.interactive=false"])
            .args(["remote", "get-url", "origin"]),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stamp_from_either_service_becomes_the_same_number() {
        /* GitHub writes whole seconds, Azure DevOps writes milliseconds, and the
           same instant has to come out the same number either way. */
        assert_eq!(epoch_ms("2026-08-27T02:07:24Z"), 1787796444000);
        assert_eq!(epoch_ms("2026-08-27T02:07:24.000Z"), 1787796444000);
        assert_eq!(epoch_ms("2026-08-27T02:07:24.277Z"), 1787796444277);
    }

    #[test]
    fn a_stamp_that_is_not_one_is_a_zero_rather_than_a_panic() {
        /* The ordinary case, not an error: a queued build has no start time and
           a step that has not run has neither. */
        assert_eq!(epoch_ms(""), 0);
        assert_eq!(epoch_ms("null"), 0);
        assert_eq!(epoch_ms("2026-13-01T00:00:00Z"), 0);
        assert_eq!(epoch_ms("2026-08-00T00:00:00Z"), 0);
    }

    #[test]
    fn a_project_with_a_space_survives_being_put_in_a_url() {
        assert_eq!(encode("TX Development Squad"), "TX%20Development%20Squad");
        assert_eq!(encode("volery"), "volery");
        assert_eq!(encode("a/b"), "a%2Fb");
    }
}
