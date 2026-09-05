//! What is left of the allowance, asked of the only thing that knows.
//!
//! `usage.rs` reads the transcripts and answers "what has this cost". That is a
//! real question and it is not the one you ask at four in the afternoon. The one
//! you ask then is **how much of the five-hour window is gone and when does it
//! come back** — what `/usage` prints in the CLI — and for a long time this app
//! answered it by inference, because the note at the top of `usage.ts` was right
//! that a transcript records no limit. `rateLimits` appears in the files only on
//! error records and is `null` on every one of them.
//!
//! It is not right that *nothing* knows. Claude Code asks
//! `GET /api/oauth/usage`, signed with the OAuth token it already holds, and is
//! answered with the utilization of every window the account has and the moment
//! each one rolls. Probed 2026-08-17 against claude 2.1.229 on a `team` plan at
//! `default_claude_max_5x`:
//!
//! ```text
//! five_hour  { utilization: 8.0, resets_at: "2026-08-17T11:39:59.968762+00:00" }
//! seven_day  { utilization: 8.0, resets_at: "2026-08-23T04:59:59.968782+00:00" }
//! limits: [ { kind: "session",       group: "session", percent: 8, severity: "normal", is_active: true  },
//!           { kind: "weekly_all",    group: "weekly",  percent: 8, severity: "normal", is_active: false },
//!           { kind: "weekly_scoped", group: "weekly",  percent: 0, severity: "normal", is_active: false,
//!             scope: { model: { display_name: "Fable" } } } ]
//! ```
//!
//! Four things about that endpoint carry this module:
//!
//! - **`limits[]` is the shape to read, not the named keys.** The response also
//!   carries `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet` —
//!   and, on this account, `seven_day_cowork`, `nimbus_quill`, `tangelo`,
//!   `iguana_necktie`, `amber_ladder`, `cinder_cove` and `omelette_promotional`,
//!   all but one of them null. Those are codenames for windows that do not exist
//!   yet, and a reader keyed on the names would show nothing for whichever one
//!   the account is eventually given. `limits[]` is the projection the CLI's own
//!   readout maps over, it carries a `scope.model.display_name` for the scoped
//!   ones, and a window added next month arrives in it already labelled. The
//!   named keys are kept only as a fallback, for the two that have always been
//!   there.
//!
//! - **The token is read and never refreshed.** `~/.claude/.credentials.json`
//!   holds an access token and a *refresh* token, and spending the refresh token
//!   rotates it — so a Skein that refreshed would race the CLI for the one
//!   credential both of them sign in with, and the loser is signed out. Skein is
//!   a reader here: if the access token has expired it says so and waits, which
//!   costs nothing, because anything that makes this wall interesting also makes
//!   the CLI refresh it within the hour.
//!
//! - **Nothing about the credential leaves this file.** Not into a fault string,
//!   not into the snapshot, not into a log. `source` says *where* the token came
//!   from and never a fragment of it — the rule `azdo.md` already states, and the
//!   reason is the same: a snapshot gets written to a file.
//!
//! - **This network intercepts TLS**, so the client is `ureq` with
//!   `native-certs` for exactly the reason `azdo.rs` documents at length. Built
//!   the obvious way this fails on every corporate wifi and works perfectly at
//!   home.
//!
//! - **The endpoint rate limits, and it counts asks rather than answers.** On
//!   2026-08-17 a wall polling this on a minute was answered `429`, which is the
//!   one refusal that asking again makes worse. So a refusal is not merely
//!   reported: it starts a *hush*, and while the hush lasts nothing here goes
//!   near the network — see `FLOOR_MS` and `HUSH_MIN_MS` below. The hush is the
//!   only piece of state that survives `release_limits`, because a hush a
//!   detach could clear is a hush a widget's knob could clear.
//!
//! Facts and never verbs, the split `perf.rs`, `usage.rs` and `azdo.rs` all
//! draw. What a percentage *means*, what a window is called, when it has run
//! close enough to be worth a colour and how a reset is worded are `limits.ts`'s,
//! which is pure and tested.

use serde::Serialize;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};

use crate::usage::epoch_ms;

const ENDPOINT: &str = "https://api.anthropic.com/api/oauth/usage";

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const READ_TIMEOUT: Duration = Duration::from_secs(10);

/// The most often the endpoint is asked, whoever asks. The front end polls on
/// three minutes and the control surface's `read` forces a pass, and neither of
/// those should be able to turn a widget into a hammer: a five-hour window moves
/// one percent in three minutes and the face prints whole percents, so a minute
/// is already twice as often as anything can be drawn.
const FLOOR_MS: i64 = 60_000;

/// The first hush after a refusal, doubling with each one after it.
///
/// The floor above is about there being nothing to gain; this is about the
/// server having said so. `429` is the one answer that asking again makes worse,
/// and a poll that keeps its cadence through one is a poll that turns a minute
/// of rate limiting into an afternoon of it.
const HUSH_MIN_MS: i64 = 60_000;

/// How far the doubling goes on its own. A `Retry-After` longer than this is
/// still obeyed — the cap bounds how long *this* will guess for, not how long
/// the server may ask for.
const HUSH_MAX_MS: i64 = 30 * 60_000;

/// A `Retry-After` past this is read as nonsense and clamped. A day is already
/// far past any hush that outlives the app.
const DAY_MS: i64 = 24 * 60 * 60_000;

/// One `Cache` per account, keyed by the account's label — and `""` for the
/// account Claude Code is signed in as, which is the only one that existed
/// before `accounts.rs` and is still what the usage widget draws.
///
/// Keyed rather than single because **everything in a `Cache` is owed to one
/// credential**. The floor is about not asking the same question twice for the
/// same answer, and three accounts are three different answers; the hush is the
/// server refusing *this* token, and letting one account's 429 silence the other
/// two would turn one exhausted subscription into a wall that cannot see any of
/// them. That is the exact failure this feature exists to avoid.
///
/// The cost is that a wall with three accounts makes three requests a minute
/// where it made one. That is the floor doing its job, not a regression: the
/// endpoint counts asks per token, and these are different tokens.
#[derive(Default)]
pub struct Limits(Mutex<std::collections::HashMap<String, Cache>>);

#[derive(Default)]
struct Cache {
    last: Option<Report>,
    /// When the endpoint was last actually asked — set whether it answered or
    /// refused, so a failing call is throttled exactly like a working one and a
    /// network that is down is not asked sixty times a minute.
    asked: i64,
    /// Nothing is asked before this instant, because the server said so.
    quiet_until: i64,
    /// How long the current hush runs, doubling per refusal and cleared by an
    /// answer — kept apart from `quiet_until` so the doubling has somewhere to
    /// stand once the waiting is over.
    hush: i64,
    /// What the server refused with, so the hush can go on saying it rather
    /// than reporting a bare wait nobody can account for.
    hush_say: String,
}

/// One window the account is measured against.
///
/// `kind` is the rate limiter's own vocabulary rather than anything readable —
/// `session`, `weekly_all`, `weekly_scoped` — and is deliberately passed through
/// unchanged, because the same words come back in the `anthropic-ratelimit-*`
/// headers when a limit is actually hit. A window you were watching and the
/// window that stopped you should be nameable as the same thing.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Window {
    kind: String,
    /// `session` or `weekly` — which clock this one runs on.
    group: String,
    /// Percent of the allowance used, 0–100. The server's own figure; nothing
    /// here recomputes it from tokens, since only the server knows the divisor.
    used: f64,
    /// What the server itself calls this level — `normal`, `warning`, and the
    /// rejection states. Carried rather than obeyed: `limits.ts` derives its own
    /// tone and takes whichever of the two is worse, so a window at 98% is never
    /// drawn calm because a field arrived saying so.
    severity: String,
    /// When this window rolls, epoch ms, or `None` when the server names no
    /// reset — which a scoped window nobody has touched genuinely does.
    resets_at: Option<i64>,
    /// What the window is scoped to, when it is scoped at all: a model's display
    /// name, as the server spells it.
    scope: Option<String>,
    /// Whether the server considers this the window currently binding.
    active: bool,
}

/// Usage past the plan's allowance, when the account has it turned on. Carried
/// because without it a window pinned at 100% is a lie in the other direction:
/// work is still going through, it is simply being billed.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Overage {
    enabled: bool,
    used: Option<f64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    windows: Vec<Window>,
    overage: Option<Overage>,
    /// When this reading was taken, epoch ms.
    at: i64,
    /// Where the token came from. Never any part of the token itself.
    source: String,
    /// The plan, as the account names it (`max`, `team`, `pro`). The only thing
    /// in the reading that says what these percentages are a percentage *of*.
    plan: Option<String>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/* ── the credential ────────────────────────────────────────────────────────*/

/// A token, and a word for where it was found. The word is all that is ever
/// reported; the token goes straight into one header and nowhere else.
struct Token {
    value: String,
    source: String,
    plan: Option<String>,
}

/// The token Claude Code is signed in with, if it is signed in.
///
/// Two places, in the order the CLI itself prefers them: the environment
/// variable a headless install is configured with, then the credentials file a
/// normal sign-in writes. An account on Bedrock or Vertex has neither and never
/// will, which is not a fault — it is an account these windows do not apply to,
/// and `read_limits` says so in those words.
fn token(app: &AppHandle, label: Option<&str>) -> Result<Token, String> {
    /* A registered account is asked about with its own credential, out of the
       store `accounts.rs` owns — the same file in the same shape as the global
       sign-in below, because it *is* a `claude auth login` credential; only the
       directory differs. `source` names the account rather than the file, which
       is the same rule as ever — where it was found, never a fragment of it —
       and here it is also the only way a reading says which subscription it is a
       reading *of*. */
    if let Some(label) = label.filter(|l| !l.is_empty()) {
        let path = crate::accounts::credential_path(app, label)?;
        return credential(&path, &format!("the '{label}' account")).map_err(|e| match e {
            Missing => format!("'{label}' is not signed in — sign in to it in the accounts panel"),
            Said(s) => s,
        });
    }

    if let Ok(v) = std::env::var("CLAUDE_CODE_OAUTH_TOKEN") {
        let v = v.trim().to_string();
        if !v.is_empty() {
            return Ok(Token {
                value: v,
                source: "CLAUDE_CODE_OAUTH_TOKEN".into(),
                /* A bare token does not announce its plan — under token auth
                   the CLI's own `auth status` omits `subscriptionType` too
                   (probed 2026-08-19). So the percentages have no denominator
                   to name, and `planSaid` falls back to "allowance". Better
                   than guessing. */
                plan: None,
            });
        }
    }

    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("no home dir: {e}"))?;
    let path = home.join(".claude").join(".credentials.json");
    credential(&path, "the CLI's sign-in").map_err(|e| match e {
        Missing => "not signed in to Claude Code on this machine".to_string(),
        Said(s) => s,
    })
}

/// Why a credential could not be used: absent, or present and unusable.
///
/// Two cases rather than one string because the *same* absence is worded
/// differently for the two callers — "not signed in to Claude Code on this
/// machine" is right for the global store and quite wrong for an account in the
/// order, which has its own next step. Everything past absence reads the same
/// either way, so only that one case is handed back to the caller to word.
enum Fault {
    Missing,
    Said(String),
}
use Fault::{Missing, Said};

/// One Claude Code credential file, read for the access token in it.
///
/// The shape `claude auth login` writes, whichever store it wrote into:
/// `claudeAiOauth: { accessToken, refreshToken, expiresAt, scopes,
/// subscriptionType }`. Nothing here refreshes it — see the note at the top of
/// the file — and nothing here writes it: the CLI owns this file, and the child
/// on this account is what keeps it current.
fn credential(path: &std::path::Path, source: &str) -> Result<Token, Fault> {
    let raw = std::fs::read_to_string(path).map_err(|_| Missing)?;
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|_| Said(format!("{source} could not be read")))?;

    let oauth = doc
        .get("claudeAiOauth")
        .ok_or_else(|| Said(format!("{source} is not a Claude account sign-in")))?;
    let value = oauth
        .get("accessToken")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if value.is_empty() {
        return Err(Said(format!("{source} holds no access token")));
    }

    /* Expiry is checked here rather than left to the server, because a token we
       can see has expired is one request we know the answer to. Skein does not
       refresh it — see the note at the top — so the honest reading is to say the
       sign-in is stale and pick it up on a later pass; the file is re-read every
       time, so the moment the CLI rotates it this recovers on its own.

       An account held in reserve is the case that makes this more than a
       formality: nothing runs on it by definition, so nothing refreshes it, and
       its reading can be stale exactly when the waterfall wants to move work
       there. That is why `accounts.ts::standingOf` treats an unreadable
       allowance as an account that is usable-but-unmeasured rather than an
       unusable one — the first turn on it refreshes the store and every reading
       after that is real. */
    let expires = oauth.get("expiresAt").and_then(|v| v.as_i64()).unwrap_or(0);
    if expires > 0 && expires <= now_ms() {
        return Err(Said(format!(
            "{source} has expired — it refreshes on its next turn"
        )));
    }

    Ok(Token {
        value,
        source: source.to_string(),
        plan: oauth
            .get("subscriptionType")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string()),
    })
}

/* ── reading the answer ────────────────────────────────────────────────────*/

fn text(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

fn percent(v: &serde_json::Value, key: &str) -> Option<f64> {
    v.get(key)
        .and_then(|x| x.as_f64())
        .filter(|n| n.is_finite())
        .map(|n| n.clamp(0.0, 1000.0))
}

fn reset(v: &serde_json::Value, key: &str) -> Option<i64> {
    v.get(key).and_then(|x| x.as_str()).and_then(epoch_ms)
}

/// The two windows that have always been there, read off their named keys.
///
/// Only reached when `limits[]` is missing or empty — an older server, or a
/// shape that changed under us. Losing the scoped windows in that case is
/// acceptable; losing the five-hour one is not, and it is the whole reason this
/// widget exists.
fn named(doc: &serde_json::Value) -> Vec<Window> {
    const KEYS: [(&str, &str, &str, Option<&str>); 4] = [
        ("five_hour", "session", "session", None),
        ("seven_day", "weekly_all", "weekly", None),
        ("seven_day_opus", "weekly_scoped", "weekly", Some("Opus")),
        ("seven_day_sonnet", "weekly_scoped", "weekly", Some("Sonnet")),
    ];
    let mut out = Vec::new();
    for (key, kind, group, scope) in KEYS {
        let Some(w) = doc.get(key).filter(|v| !v.is_null()) else {
            continue;
        };
        let Some(used) = percent(w, "utilization") else {
            continue;
        };
        out.push(Window {
            kind: kind.into(),
            group: group.into(),
            used,
            severity: "normal".into(),
            resets_at: reset(w, "resets_at"),
            scope: scope.map(|s| s.to_string()),
            active: kind == "session",
        });
    }
    out
}

fn windows(doc: &serde_json::Value) -> Vec<Window> {
    let mut out = Vec::new();
    if let Some(rows) = doc.get("limits").and_then(|v| v.as_array()) {
        for row in rows {
            let Some(kind) = text(row, "kind") else {
                continue;
            };
            let Some(used) = percent(row, "percent") else {
                continue;
            };
            out.push(Window {
                group: text(row, "group").unwrap_or_else(|| kind.clone()),
                kind,
                used,
                severity: text(row, "severity").unwrap_or_else(|| "normal".into()),
                resets_at: reset(row, "resets_at"),
                /* `scope` is present and null on the unscoped rows, and on the
                   scoped one it is `{ model: { display_name } }` with `id` null
                   — so the display name is the only part of it worth carrying,
                   and the only part that is reliably filled in. */
                scope: row
                    .get("scope")
                    .and_then(|s| s.get("model"))
                    .and_then(|m| m.get("display_name"))
                    .and_then(|n| n.as_str())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string()),
                active: row
                    .get("is_active")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
            });
        }
    }
    if out.is_empty() {
        out = named(doc);
    }
    out
}

fn overage(doc: &serde_json::Value) -> Option<Overage> {
    let x = doc.get("extra_usage").filter(|v| !v.is_null())?;
    Some(Overage {
        enabled: x
            .get("is_enabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        used: percent(x, "utilization"),
    })
}

/* ── being told to wait ────────────────────────────────────────────────────*/

/// A wait, in the fewest characters that still say it. Rounded *up* throughout,
/// so a hush with a moment left on it never reads `0s` — this goes in the note
/// beside a stale reading, and a countdown that reaches zero and stays there is
/// the one thing worse than no countdown.
fn soon(ms: i64) -> String {
    let secs = (ms.max(0) + 999) / 1000;
    if secs < 60 {
        return format!("{secs}s");
    }
    let mins = (secs + 59) / 60;
    if mins < 60 {
        return format!("{mins}m");
    }
    let (h, m) = (mins / 60, mins % 60);
    if m == 0 {
        format!("{h}h")
    } else {
        format!("{h}h {m}m")
    }
}

/// What a `Retry-After` header is worth, in ms.
///
/// Seconds only, integral or not. The header may also carry an HTTP-date, and
/// this endpoint has not been seen to send one; a date is read here as the
/// server having said nothing, which costs only the difference between its
/// number and `next_hush`'s guess. A second date parser to save that is the
/// trade `usage.rs::epoch_ms` already refused once.
fn after_ms(raw: &str) -> Option<i64> {
    let secs: f64 = raw.trim().parse().ok()?;
    if !secs.is_finite() || secs < 0.0 {
        return None;
    }
    Some(((secs * 1000.0).ceil() as i64).min(DAY_MS))
}

/// How long to stay away, given how long we stayed away last time and whatever
/// the server asked for.
///
/// The doubling is what makes a refusal cost less each time it is repeated; the
/// `max` is what keeps it from ever being *shorter* than the server asked, which
/// is the only way a backoff can be politely wrong.
fn next_hush(prev: i64, after: Option<i64>) -> i64 {
    let ours = if prev <= 0 {
        HUSH_MIN_MS
    } else {
        prev.saturating_mul(2).min(HUSH_MAX_MS)
    };
    after.map_or(ours, |a| a.max(ours))
}

/* ── asking ────────────────────────────────────────────────────────────────*/

/// Why the endpoint did not answer, and whether it asked to be left alone.
struct Refusal {
    say: String,
    /// Set when asking again soon would be worse than not asking — the server
    /// rate limiting us, or telling us it is in no state to answer. A sign-in
    /// that has gone stale is not one of these: that recovers by itself and the
    /// next pass is the thing that notices.
    hush: bool,
    /// What `Retry-After` said, where it said anything.
    after: Option<i64>,
}

impl Refusal {
    fn fault(say: impl Into<String>) -> Self {
        Refusal { say: say.into(), hush: false, after: None }
    }
    fn wait(say: impl Into<String>, after: Option<i64>) -> Self {
        Refusal { say: say.into(), hush: true, after }
    }
}

fn ask(token: &Token) -> Result<serde_json::Value, Refusal> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(CONNECT_TIMEOUT)
        .timeout_read(READ_TIMEOUT)
        .build();

    match agent
        .get(ENDPOINT)
        .set("Authorization", &format!("Bearer {}", token.value))
        .set("Accept", "application/json")
        /* The beta the OAuth-scoped endpoints are gated behind. Sent explicitly
           rather than relied upon by default, which is how the CLI sends it. */
        .set("anthropic-beta", "oauth-2025-04-20")
        .call()
    {
        Ok(res) => res
            .into_json::<serde_json::Value>()
            .map_err(|e| Refusal::fault(format!("unreadable answer: {e}"))),
        /* 401 here is the sign-in having gone stale between the expiry check
           above and the call — said in the same words, since it has the same
           answer: the CLI will refresh it, and this recovers by itself. Named
           by its source so a wall with three accounts says *which* one. */
        Err(ureq::Error::Status(401, _)) => Err(Refusal::fault(format!(
            "{} has expired — it refreshes on its next turn",
            token.source
        ))),
        /* 403 is very nearly always one thing, and it is worth naming rather
           than reporting as a bare refusal: the credential is scoped
           `user:inference` and this endpoint needs `user:profile`. That is what
           every `claude setup-token` token is, and the whole reason an account
           is a credential store now — see `accounts.rs`. Probed 2026-08-19: a
           setup-token token gets 403 here where a `claude auth login`
           credential for the same account gets 200. */
        Err(ureq::Error::Status(403, _)) => Err(Refusal::fault(format!(
            "{} cannot be asked about its allowance — it is signed in with an inference-only token rather than a full sign-in",
            token.source
        ))),
        /* The one refusal that is *about* how often we asked. Named in plain
           words rather than by its number, because the number is the part of it
           nobody reading a widget can act on. */
        Err(ureq::Error::Status(429, res)) => Err(Refusal::wait(
            "the allowance endpoint is rate limiting this poll",
            res.header("retry-after").and_then(after_ms),
        )),
        /* A server saying it is overloaded is saying the same thing 429 says,
           and a five-minute outage answered at the usual cadence is a hundred
           requests that could not have been answered. */
        Err(ureq::Error::Status(code, res)) if code >= 500 => Err(Refusal::wait(
            format!("the allowance endpoint answered {code}"),
            res.header("retry-after").and_then(after_ms),
        )),
        Err(ureq::Error::Status(code, _)) => Err(Refusal::fault(format!(
            "the allowance endpoint answered {code}"
        ))),
        Err(e) => Err(Refusal::fault(format!(
            "could not reach the allowance endpoint: {e}"
        ))),
    }
}

/// What is left of the allowance, and when each window rolls.
///
/// Cheap to call often — `FLOOR_MS` and the hush are what make that true. A
/// pass inside the floor hands back the reading already held rather than asking
/// again, so the front end's poll, the control surface's forced read and however
/// many widgets are on the wall all collapse into one request per minute at
/// worst; a pass inside a hush asks nothing at all.
///
/// **A refusal is reported even when a reading is held**, rather than the held
/// one being handed back as though it were current. The front end keeps what it
/// last saw and draws it beside the fault as `stale`, which is the arrangement
/// this file's half of `usage.md` describes: a percentage does not become wrong
/// because the network went away, and it does not stay right either.
///
/// Fails rather than inventing: an account with no OAuth sign-in (Bedrock,
/// Vertex, an API key) has no windows of this kind at all, and a widget drawing
/// a confident 0% for one would be worse than a widget saying it cannot see.
///
/// Off the main thread, via `crate::off_main`: this leaves the machine, against
/// a five second connect and a ten second read, and on the main thread that wait
/// was the whole wall's. `release_limits` stays where it is — it contends for the
/// same mutex, but nothing here holds that mutex across the request.
#[tauri::command]
pub async fn read_limits(app: AppHandle) -> Result<Report, String> {
    crate::off_main(move || report_with(&app, &app.state::<Limits>(), "")).await?
}

/// The allowance of every named account, for the waterfall in `accounts.ts`.
///
/// One entry per label asked for, each carrying either a reading or the reason
/// there isn't one — **never collapsing the two**, because "this account is
/// full" and "this account could not be asked" are answered completely
/// differently: one is waited out and the other is a thing to go and fix.
/// `accounts.ts::standingOf` is what draws that line, and it can only draw it
/// if this keeps the distinction intact.
///
/// Accounts are asked one after another rather than concurrently. Three
/// sequential requests against a five-second connect timeout is a worst case of
/// fifteen seconds on a blocking pool thread, which `off_main` is built for;
/// making them concurrent would need an async client this crate does not have,
/// to save time on a call that runs once a minute behind a floor.
#[tauri::command]
pub async fn read_allowances(
    app: AppHandle,
    labels: Vec<String>,
) -> Result<Vec<Allowance>, String> {
    crate::off_main(move || {
        let state = app.state::<Limits>();
        labels
            .into_iter()
            .filter(|l| !l.is_empty())
            .map(|label| match report_with(&app, &state, &label) {
                Ok(report) => Allowance { label, report: Some(report), fault: None },
                Err(fault) => Allowance { label, report: None, fault: Some(fault) },
            })
            .collect()
    })
    .await
}

/// One account's answer. A `report` or a `fault`, and exactly one of them.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Allowance {
    pub label: String,
    pub report: Option<Report>,
    pub fault: Option<String>,
}

/// The reading itself, apart from the command that carries it.
fn report_with(app: &AppHandle, state: &Limits, label: &str) -> Result<Report, String> {
    let now = now_ms();
    {
        let mut all = state.0.lock().unwrap();
        let cache = all.entry(label.to_string()).or_default();
        /* The hush is checked before anything else and holds whether or not a
           reading is in hand: the server has asked to be left alone, and every
           way of not-quite-obeying that is worse than the wait. */
        if now < cache.quiet_until {
            return Err(format!(
                "{} — asking again in {}",
                cache.hush_say,
                soon(cache.quiet_until - now)
            ));
        }
        if now - cache.asked < FLOOR_MS {
            /* Inside the floor with nothing held, the answer is still not to
               ask. `release_limits` drops the reading, so a knob turned from
               the allowance to the cost and back is two attaches with no cache
               between them — and letting that fall through is a gesture that
               costs a request every time it is made. */
            return match &cache.last {
                Some(last) => Ok(last.clone()),
                None => Err(format!(
                    "the allowance was asked for a moment ago — asking again in {}",
                    soon(FLOOR_MS - (now - cache.asked))
                )),
            };
        }
    }

    let token = token(app, Some(label))?;
    /* The clock starts before the call, not after it: a request that takes ten
       seconds to time out must not then be allowed to go again immediately. */
    state
        .0
        .lock()
        .unwrap()
        .entry(label.to_string())
        .or_default()
        .asked = now;

    let doc = match ask(&token) {
        Ok(doc) => doc,
        Err(refusal) if !refusal.hush => return Err(refusal.say),
        Err(refusal) => {
            let mut all = state.0.lock().unwrap();
            let cache = all.entry(label.to_string()).or_default();
            cache.hush = next_hush(cache.hush, refusal.after);
            cache.quiet_until = now_ms() + cache.hush;
            cache.hush_say = refusal.say;
            return Err(format!(
                "{} — asking again in {}",
                cache.hush_say,
                soon(cache.hush)
            ));
        }
    };

    let report = Report {
        windows: windows(&doc),
        overage: overage(&doc),
        at: now_ms(),
        source: token.source,
        plan: token.plan,
    };

    let mut all = state.0.lock().unwrap();
    let cache = all.entry(label.to_string()).or_default();
    cache.last = Some(report.clone());
    /* An answer ends the hush and puts the doubling back at the bottom.
       Whatever the server was protecting itself from has passed, and carrying
       the old span forward would make the next unrelated refusal a fortnight
       later start at half an hour. */
    cache.hush = 0;
    cache.quiet_until = 0;
    cache.hush_say = String::new();
    Ok(report)
}

/// Forget the reading and the credential's whereabouts. Called when the last
/// widget stops watching, for the reason `release_azdo` and
/// `release_performance` exist: a wall with nothing asking should hold nothing.
///
/// What is *kept* is everything owed to the endpoint — when it was last asked,
/// and any hush it is serving. Those are not the wall's to drop: a hush a detach
/// could clear is a hush a widget's knob could clear, and a wall being rate
/// limited would go on being rate limited by the very gesture made to stop it.
/// Three integers and the sentence the server refused with; no credential is in
/// any of them.
#[tauri::command]
pub fn release_limits(state: State<'_, Limits>) {
    /* Every account's reading, not just the signed-in one — a wall with nothing
       watching holds nothing, and that has to mean all of it. The endpoint's
       bookkeeping stays, per account, for the reason above: a hush a detach
       could clear is a hush a widget's knob could clear. */
    for cache in state.0.lock().unwrap().values_mut() {
        cache.last = None;
    }
}

/* ── what a card may ask about the bill ────────────────────────────────────
 *
 * `allowance`, the fifth tool on `ask.rs`'s server, and the one thing on it that
 * no other harness could offer: nobody else holds the account. An agent deciding
 * whether to fan out ten subagents or make one careful pass is currently
 * deciding blind, and finds out which it should have been by being cut off in
 * the middle. This is the reading it would have wanted first.
 *
 * Read-only, and free in the sense the billboard is free: it costs the wall
 * nothing and it costs no other card a turn. Cheap to call, too — `report_with`
 * is behind `FLOOR_MS` and the hush, so a card asking on every turn collapses
 * into the same one request a minute the widgets already share.
 */

pub const ALLOWANCE_TOOL: &str = "allowance";

/// How far back the spend figure looks.
///
/// A rolling day rather than "today", and that is the one place this parts
/// company with `spend_since` — whose cutoff comes from the front end because
/// **the timezone lives there** (see the note on that command). Nothing in Rust
/// knows where midnight is, and a guessed one would make the number wrong twice
/// a year and at every hour before breakfast. A rolling window needs no
/// timezone, and is the more useful reading here anyway: an agent wants to know
/// what this wall has been costing lately, not what a calendar says.
const SPEND_WINDOW_MS: i64 = 24 * 60 * 60 * 1_000;

pub fn allowance_schema() -> serde_json::Value {
    serde_json::json!({
        "name": ALLOWANCE_TOOL,
        /* "the Claude subscription", definite and singular, was half of the
           bug this file's `scope_line` fixes: a wall can hold several accounts
           and swap a card between them, so the article was a claim about the
           wall made by a tool that reads one member of it. The description is
           where an agent forms its expectation of what the number means, so it
           has to be the first place that says "one account" out loud. */
        "description":
            "How much of **this card's own account's** Claude allowance is left, and \
             what this wall has spent in the last day. Read it **before** committing \
             to something expensive — a fan-out of subagents, an exhaustive audit, a \
             long autonomous loop — so the shape of the work is a decision rather \
             than something a rate limit makes for you halfway through.\n\n\
             What comes back is one account's own figures: a percentage used per \
             window, when each rolls, and the plan they are a percentage of. A wall \
             can hold several accounts and move a card between them, so a spent \
             reading here is not a spent wall — the answer says how many other \
             accounts there are, and it does not read them. Costs nothing and takes \
             no other conversation's time.\n\n\
             Use it to scale ambition, and say what you did. With nothing behind it, \
             a nearly-spent window means one careful pass rather than ten agents, and \
             the user should be told that is why. With another account usable, a \
             spent one is a reason to expect a swap and not a reason to stop. **Do \
             not** call it every turn out of habit — it answers a question about a \
             plan, and a plan does not change between one edit and the next.",
        "inputSchema": { "type": "object", "properties": {} }
    })
}

/// Route a `tools/call` that belongs to this file. `None` for a name it does not
/// claim, so `ask.rs` can go on asking.
///
/// `caller` is the asking card's id, and this file was the one handler on
/// `ask.rs`'s chain that did not take it — which is the whole of the bug below.
pub fn handle(
    app: &AppHandle,
    caller: &str,
    tool: &str,
    _args: &serde_json::Value,
) -> Option<String> {
    (tool == ALLOWANCE_TOOL).then(|| do_allowance(app, caller))
}

/// Blocking, on the MCP request's own thread. `ask::start` gives every request a
/// thread of its own — the parked question needed it — so the network call here
/// is nobody's main thread and wants no `off_main`. The `#[tauri::command]`
/// version above does, for the reason stated there.
fn do_allowance(app: &AppHandle, caller: &str) -> String {
    /* One lock for both readings. They are two unrelated questions of the same
       connection and there is no reason to contend for it twice. */
    let (spent, label, usable) = app
        .try_state::<crate::store::Store>()
        .and_then(|s| {
            s.0.lock().ok().map(|conn| {
                (
                    crate::store::spend_over(&conn, now_ms() - SPEND_WINDOW_MS),
                    crate::store::account_of(&conn, caller),
                    crate::accounts::usable_labels(app, &conn),
                )
            })
        })
        .unwrap_or((0.0, None, Vec::new()));
    let day = format!("This wall has spent ${spent:.2} in the last 24 hours.");

    /* How much of the wall this reading is *not*. The scoping below is right and
       stays; what was missing is any admission of it, and a percentage with no
       scope stated is read as the wall's. A card with no account of its own is
       on the CLI's global sign-in, which is not one of these rows, so every
       usable account is one this reading passes over. */
    let others = usable
        .iter()
        .filter(|l| Some(l.as_str()) != label.as_deref())
        .count();

    /* **The asking card's account, not the wall's.** This passed `""` — the
       CLI's own sign-in — for every caller, so a card spawned on a registered
       account was told about a subscription it was not spending. Where the
       machine's global sign-in is not an OAuth one, the same line reported *no
       subscription at all*, and the `Err` arm below then explained that away as
       per-token billing: an agent asked what it could afford, was told its plan
       did not exist, and scaled its work to a wall it was not on. `""` is still
       the right label for a card with no account of its own — `token` reads it
       as the global sign-in, which is what `account_label = NULL` means. */
    let asked = label.as_deref().unwrap_or("");
    let report = match report_with(app, &app.state::<Limits>(), asked) {
        Ok(r) => r,
        /* Named rather than smoothed over. An account on Bedrock, Vertex or an
           API key has no windows of this kind at all, and answering "0% used"
           for one would have an agent spend against an allowance that does not
           exist. `read_limits` refuses for the same reason and says so there. */
        Err(fault) => {
            /* Two different faults wearing one sentence was the second half of
               the bug. "This account is billed per token" is a claim about the
               plan; "this account could not be asked" is a thing to go and fix,
               and `accounts.ts::standingOf` exists precisely because collapsing
               them answers the wrong question. So the cause is handed over as
               the cause, and the per-token reading is offered as one possible
               reading rather than asserted as the explanation. */
            let whose = match &label {
                Some(l) => format!("the '{l}' account this card is on"),
                None => "the account Claude Code is signed in as".to_string(),
            };
            return format!(
                "{day}\n\nNo subscription allowance could be read for {whose}: {fault}\n\n\
                 That is expected for an account billed per token rather than by plan — \
                 Bedrock, Vertex or an API key have no windows of this kind — in which \
                 case the figure above is what the work is actually costing and is the \
                 thing to scale to. But it is also what a sign-in that has expired or \
                 was never made looks like, and those are worth fixing rather than \
                 working around. Do not report to the user that they are on per-token \
                 billing on the strength of this line alone.{}",
                elsewhere(others)
            )
        }
    };

    let mut out = String::new();
    /* Which subscription this is a reading of. Absent before, and unmissed only
       because there was only ever one answer; now that the card's own account is
       what gets asked, a percentage with no name on it is a percentage the user
       cannot check. `source` is where the credential was found and never a
       fragment of it — the rule the rest of this file keeps. */
    out.push_str(&scope_line(&report.source, others));
    if let Some(plan) = &report.plan {
        out.push_str(&format!("Plan: {plan}.\n"));
    }
    if report.windows.is_empty() {
        out.push_str("The account reports no windows, which usually means none has been \
                      touched yet this session.\n");
    }
    for w in &report.windows {
        let resets = match w.resets_at {
            Some(at) => format!(", rolls in {}", soon(at - now_ms())),
            None => ", no reset named — nothing has drawn on it yet".into(),
        };
        let scope = match &w.scope {
            Some(s) => format!(" ({s})"),
            None => String::new(),
        };
        /* "this is the binding one" was a sentence about the wall wearing a
           sentence about a window: on a waterfall the binding window of one
           account binds this card until it is swapped, and binds nothing else.
           Naming what it binds costs three words. */
        let binding = if w.active {
            " — the binding one on this account"
        } else {
            ""
        };
        out.push_str(&format!(
            "- {}{scope}: {:.0}% used{resets}{binding}\n",
            w.kind, w.used
        ));
    }
    if let Some(o) = &report.overage {
        if o.enabled {
            /* The one reading that inverts the others: a window pinned at 100%
               with overage on is not a stop, it is a bill. An agent told only
               the percentage would report to the user that it had been cut off
               when in fact the work was going through and being charged for. */
            out.push_str(&format!(
                "- past-plan usage is enabled{}, so a window at 100% does not stop the \
                 work — it bills it. Say so if you mention being near a limit.\n",
                o.used.map(|u| format!(" and at {u:.0}%")).unwrap_or_default()
            ));
        }
    }

    let worst = report
        .windows
        .iter()
        .map(|w| w.used)
        .fold(0.0f64, f64::max);
    format!("{out}\n{day}\n\n{}", advice_for(worst, others))
}

/* -- saying how much of the wall this is -----------------------------------
 *
 * The scoping this file does is right and is not what follows. `token` reads the
 * asking card's *own* account, for the reason written above it, and that stays.
 * What was wrong is that the answer never said so: a percentage arrives with no
 * scope attached, an agent reads it as the state of the wall, and on a waterfall
 * it is the state of one member of it.
 *
 * It cost a real session. A card on a spent `personal` account read "this is the
 * binding one / almost nothing is left / do not fan out", believed it, told the
 * user to hold four and a half hours of work and declined to start anything. The
 * user had three accounts and the two biggest were untouched (sink `0b4ba579`).
 *
 * So neither of the two functions below reads another account -- that would undo
 * the scoping, and the note on `token` is the argument for it -- and both of them
 * stop the answer from implying there are none.
 */

/// How many other usable accounts this reading passes over, said in words, or
/// nothing at all when it passes over none.
///
/// A suffix rather than a sentence of its own, because it has to attach to the
/// failure arm too: "no allowance could be read for this account" is *more*
/// likely to stop an agent than a high percentage is, and it was equally silent
/// about the rest of the wall.
fn elsewhere(others: usize) -> String {
    match others {
        0 => String::new(),
        1 => " One other account on this wall is usable, and nothing above is a reading \
              of it."
            .to_string(),
        n => format!(
            " {n} other accounts on this wall are usable, and nothing above is a reading \
             of any of them."
        ),
    }
}

/// Whose figures these are, and whether they are the wall's -- the first line of
/// the answer, so the scope is established before any number is.
fn scope_line(source: &str, others: usize) -> String {
    format!("Account: {source}.{}\n", elsewhere(others))
}

/// What to *do* about the number, which is the whole point of reporting one.
///
/// A percentage with no instruction attached gets read, agreed with, and then
/// ignored: the agent goes on to do exactly what it was going to do, because
/// nothing told it what a different number would have meant. Pure, so the ladder
/// is tested rather than eyeballed.
///
/// Two ladders, because the same percentage means two different things. Alone on
/// the wall, a spent window really is the end of the work, and the strict arm is
/// the one that was always right. With another account usable, the same window
/// means this *card* is close to being swapped -- which is a thing to expect, not
/// a thing to stop for, and no rung of the second ladder may say otherwise.
fn advice_for(worst: f64, others: usize) -> String {
    if others == 0 {
        return if worst >= 90.0 {
            "Almost nothing is left. Do the smallest correct thing, do not fan out, and tell \
             the user the allowance is why."
        } else if worst >= 70.0 {
            "Enough for careful work and not for a wide fan-out. Prefer one good pass over \
             several speculative ones, and say that is the trade you made."
        } else if worst >= 40.0 {
            "Comfortable. Spend it on being thorough where thoroughness pays."
        } else {
            "Plenty. There is no reason to hold back on this account's behalf."
        }
        .to_string();
    }

    let rest = if others == 1 {
        "one usable account behind it".to_string()
    } else {
        format!("{others} usable accounts behind it")
    };
    if worst >= 90.0 {
        format!(
            "This account is nearly spent, and it has {rest} that were not read here. A card \
             whose account runs out is swapped onto the next one, so this is a reason to \
             expect a swap rather than to stop: scale the work to the job. If you mention a \
             limit to the user, name the account -- do not report the wall as spent on the \
             strength of one member of it."
        )
    } else if worst >= 70.0 {
        format!(
            "This account is well into its window, with {rest}. Expect a swap before you \
             expect a wall: scale the work to the job, and name the account rather than the \
             wall if a limit comes up."
        )
    } else if worst >= 40.0 {
        format!("Comfortable, with {rest}. Spend it on being thorough where thoroughness pays.")
    } else {
        format!("Plenty, with {rest}. There is no reason to hold back.")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The exact body the endpoint returned on 2026-08-17, trimmed to the parts
    /// this module reads — including the null codenamed windows, which are the
    /// reason `limits[]` is preferred over the named keys.
    const REAL: &str = r#"{
      "five_hour": {"utilization": 8.0, "resets_at": "2026-08-17T11:39:59.968762+00:00"},
      "seven_day": {"utilization": 8.0, "resets_at": "2026-08-23T04:59:59.968782+00:00"},
      "seven_day_opus": null, "seven_day_sonnet": null, "seven_day_cowork": null,
      "tangelo": null, "iguana_necktie": null, "cinder_cove": null,
      "nimbus_quill": {"utilization": 0.0, "resets_at": null},
      "extra_usage": {"is_enabled": false, "utilization": null},
      "limits": [
        {"kind":"session","group":"session","percent":8,"severity":"normal",
         "resets_at":"2026-08-17T11:39:59.968762+00:00","scope":null,"is_active":true},
        {"kind":"weekly_all","group":"weekly","percent":8,"severity":"normal",
         "resets_at":"2026-08-23T04:59:59.968782+00:00","scope":null,"is_active":false},
        {"kind":"weekly_scoped","group":"weekly","percent":0,"severity":"normal",
         "resets_at":null,"scope":{"model":{"id":null,"display_name":"Fable"}},
         "is_active":false}
      ]}"#;

    #[test]
    fn the_real_answer_reads_as_three_windows() {
        let doc: serde_json::Value = serde_json::from_str(REAL).unwrap();
        let w = windows(&doc);
        assert_eq!(w.len(), 3, "limits[] is read, not the named keys");

        assert_eq!(w[0].kind, "session");
        assert_eq!(w[0].used, 8.0);
        assert!(w[0].active);
        /* 2026-08-17T11:39:59.968Z, which is four days and 5h32m11.604s past the
           stamp `usage.rs` pins its own parser against. The offset is `+00:00`
           here, and the point of reading it at all is that it might not be. */
        assert_eq!(w[0].resets_at, Some(1_786_966_799_968));

        assert_eq!(w[1].kind, "weekly_all");
        assert_eq!(w[1].scope, None);

        assert_eq!(w[2].kind, "weekly_scoped");
        assert_eq!(w[2].scope.as_deref(), Some("Fable"));
        assert_eq!(w[2].resets_at, None, "a window nobody has touched names no reset");
    }

    #[test]
    fn a_codenamed_window_is_never_mistaken_for_a_real_one() {
        /* `nimbus_quill` is non-null in the body above and is not in `limits[]`.
           Reading the named keys would have to either know that name or drop it;
           reading `limits[]` means it simply is not a window yet. */
        let doc: serde_json::Value = serde_json::from_str(REAL).unwrap();
        assert!(windows(&doc).iter().all(|w| w.scope.as_deref() != Some("nimbus_quill")));
    }

    #[test]
    fn the_named_keys_carry_it_when_the_array_is_gone() {
        let doc: serde_json::Value = serde_json::from_str(
            r#"{"five_hour":{"utilization":41.5,"resets_at":"2026-08-17T11:39:59.968762+00:00"},
                "seven_day":{"utilization":12.0,"resets_at":null},
                "seven_day_opus":{"utilization":3.0,"resets_at":null},
                "limits":[]}"#,
        )
        .unwrap();
        let w = windows(&doc);
        assert_eq!(w.len(), 3, "the fallback runs when limits[] is empty");
        assert_eq!(w[0].kind, "session");
        assert_eq!(w[0].used, 41.5);
        assert!(w[0].active, "the five-hour window is the binding one by default");
        assert_eq!(w[2].scope.as_deref(), Some("Opus"));
    }

    #[test]
    fn nothing_recognisable_is_no_windows_rather_than_a_guess() {
        let doc: serde_json::Value = serde_json::from_str(r#"{"limits":[{"nope":1}]}"#).unwrap();
        assert!(windows(&doc).is_empty());
    }

    #[test]
    fn a_refusal_costs_twice_as_much_each_time_it_is_repeated() {
        /* Nothing said by the server, so the doubling is all there is. */
        let one = next_hush(0, None);
        assert_eq!(one, HUSH_MIN_MS);
        let two = next_hush(one, None);
        assert_eq!(two, 2 * HUSH_MIN_MS);
        assert_eq!(next_hush(two, None), 4 * HUSH_MIN_MS);

        /* And it stops doubling rather than walking off into the afternoon. */
        assert_eq!(next_hush(HUSH_MAX_MS, None), HUSH_MAX_MS);
        assert_eq!(next_hush(HUSH_MAX_MS - 1, None), HUSH_MAX_MS);
    }

    #[test]
    fn the_servers_own_wait_is_obeyed_even_past_our_cap() {
        /* Shorter than the doubling: the doubling wins, since the point of it is
           that a repeated refusal costs more than the last one did. */
        assert_eq!(next_hush(4 * HUSH_MIN_MS, Some(1_000)), 8 * HUSH_MIN_MS);
        /* Longer: obeyed, and the cap does not talk it down. The cap bounds our
           guess, not the server's instruction. */
        assert_eq!(next_hush(0, Some(2 * HUSH_MAX_MS)), 2 * HUSH_MAX_MS);
    }

    #[test]
    fn retry_after_is_read_as_seconds_and_nothing_else() {
        assert_eq!(after_ms("30"), Some(30_000));
        assert_eq!(after_ms("  7 "), Some(7_000));
        /* Fractional seconds round up rather than down — a wait rounded down is
           a request sent before the server said to send one. */
        assert_eq!(after_ms("0.25"), Some(250));
        assert_eq!(after_ms("1.0005"), Some(1_001));
        /* An HTTP-date is read as the server having said nothing, which leaves
           `next_hush`'s doubling to cover it. */
        assert_eq!(after_ms("Wed, 21 Oct 2026 07:28:00 GMT"), None);
        assert_eq!(after_ms(""), None);
        assert_eq!(after_ms("-5"), None);
        assert_eq!(after_ms("inf"), None);
        /* Absurd is clamped rather than trusted into an overflow. */
        assert_eq!(after_ms("99999999999"), Some(DAY_MS));
    }

    #[test]
    fn a_wait_is_said_short_and_never_as_nothing() {
        /* Rounded up at every scale: the note beside a stale reading must not
           sit at `0s` for the last second of a hush. */
        assert_eq!(soon(1), "1s");
        assert_eq!(soon(0), "0s");
        assert_eq!(soon(29_400), "30s");
        assert_eq!(soon(60_000), "1m");
        assert_eq!(soon(61_000), "2m");
        assert_eq!(soon(HUSH_MAX_MS), "30m");
        assert_eq!(soon(2 * 60 * 60_000), "2h");
        assert_eq!(soon(90 * 60_000), "1h 30m");
    }

    /* ── allowance ────────────────────────────────────────────────────────── */

    #[test]
    fn the_allowance_tool_advertises_itself_usably() {
        let s = allowance_schema();
        assert_eq!(s["name"], ALLOWANCE_TOOL);
        assert_eq!(s["inputSchema"]["type"], "object");
        let d = s["description"].as_str().unwrap();
        /* The two sentences that make it worth having: read it *before* the
           expensive thing, and do not call it every turn. Without the first it
           is a post-mortem; without the second it is a tax on every turn of
           every card on the wall. */
        assert!(d.contains("before"), "{d}");
        assert!(d.contains("Do not"), "{d}");
    }

    /// Every rung of the ladder, on a wall with one account — see `advice_for`.
    /// The number does nothing without the instruction.
    #[test]
    fn the_advice_turns_at_each_step_and_never_says_nothing() {
        assert!(advice_for(95.0, 0).contains("smallest correct thing"));
        assert!(
            advice_for(90.0, 0).contains("smallest correct thing"),
            "the edge belongs to the stricter arm"
        );
        assert!(advice_for(75.0, 0).contains("fan-out"));
        assert!(advice_for(50.0, 0).contains("Comfortable"));
        assert!(advice_for(0.0, 0).contains("Plenty"));
        for w in [0.0, 39.9, 40.0, 69.9, 70.0, 89.9, 90.0, 100.0, 140.0] {
            for others in [0, 1, 4] {
                assert!(!advice_for(w, others).is_empty(), "{w} / {others}");
            }
        }
    }

    /// The sentence that cost a session, and the whole of `0b4ba579`.
    ///
    /// A card on a spent account was told "almost nothing is left, do not fan
    /// out", believed it about the *wall*, and stopped — with two untouched
    /// subscriptions behind it. So: with another account usable, nothing in the
    /// answer may be a thing an agent would down tools over. Asserted against the
    /// phrases that actually did it rather than against a paraphrase of them.
    #[test]
    fn no_rung_tells_an_agent_to_stop_while_another_account_is_usable() {
        const STOPPERS: [&str; 4] = [
            "Almost nothing is left",
            "do not fan out",
            "not for a wide fan-out",
            "smallest correct thing",
        ];
        for w in [0.0, 39.9, 40.0, 69.9, 70.0, 89.9, 90.0, 100.0, 140.0] {
            for others in [1, 2, 7] {
                let said = advice_for(w, others);
                for stop in STOPPERS {
                    assert!(!said.contains(stop), "{w} / {others}: {said}");
                }
                /* And it must still say the others are there. An answer that
                   merely stops discouraging is one an agent reads as a wall with
                   one account on it, which is the same wrong picture. */
                assert!(said.contains("behind it"), "{w} / {others}: {said}");
            }
        }
    }

    /// A reading with no scope on it is read as the wall's, so the scope goes
    /// first — and says nothing where there is nothing to say.
    #[test]
    fn the_answer_names_its_account_and_owns_up_to_the_rest_of_the_wall() {
        let alone = scope_line("the 'personal' account", 0);
        assert!(
            alone.starts_with("Account: the 'personal' account."),
            "{alone}"
        );
        assert!(!alone.contains("usable"), "nothing to disclaim: {alone}");

        let one = scope_line("the 'personal' account", 1);
        assert!(one.contains("One other account"), "{one}");

        let many = scope_line("the CLI's sign-in", 3);
        assert!(many.contains("3 other accounts"), "{many}");
        assert!(many.contains("nothing above is a reading"), "{many}");

        assert!(elsewhere(0).is_empty());
    }

    #[test]
    fn overage_is_read_when_the_account_has_it() {
        let doc: serde_json::Value =
            serde_json::from_str(r#"{"extra_usage":{"is_enabled":true,"utilization":34.0}}"#)
                .unwrap();
        let o = overage(&doc).unwrap();
        assert!(o.enabled);
        assert_eq!(o.used, Some(34.0));

        let none: serde_json::Value = serde_json::from_str(r#"{"extra_usage":null}"#).unwrap();
        assert!(overage(&none).is_none());
    }
}
