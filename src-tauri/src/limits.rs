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

use serde::{Deserialize, Serialize};
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
#[derive(Serialize, Deserialize, Clone)]
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
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Overage {
    enabled: bool,
    used: Option<f64>,
}

#[derive(Serialize, Deserialize, Clone)]
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
    /// Set when the request never reached anybody — see `TRIES`. The exact
    /// opposite of `hush` and never both: one is the server having answered and
    /// asked for quiet, the other is nothing having answered at all.
    flaky: bool,
    /// What `Retry-After` said, where it said anything.
    after: Option<i64>,
}

impl Refusal {
    fn fault(say: impl Into<String>) -> Self {
        Refusal { say: say.into(), hush: false, flaky: false, after: None }
    }
    fn wait(say: impl Into<String>, after: Option<i64>) -> Self {
        Refusal { say: say.into(), hush: true, flaky: false, after }
    }
    /// A request that never arrived. Worth trying again where the two above are
    /// precisely not.
    fn flaky(say: impl Into<String>) -> Self {
        Refusal { say: say.into(), hush: false, flaky: true, after: None }
    }
}

/// How many times a request that **never reached the server** is tried, in all.
///
/// It has to be argued for, sitting beside a floor and a hush that both exist to
/// ask *less*. The line is the one `Refusal` already draws: a `429` or a `500`
/// is the server having answered, and asking again is the thing that makes those
/// worse — while a connect that timed out arrived nowhere, was counted by
/// nobody, and is very often a single dropped packet on wifi that is already
/// coming back. Retrying the first is impolite; retrying the second costs the
/// endpoint nothing at all.
///
/// Two rather than more, because the cost lands somewhere easy to miss:
/// `read_allowances` asks the accounts one after another, so this multiplies by
/// the account count. Three accounts on a genuinely dead network is
/// `3 × (2 × 5s + 1s)` — a little over half a minute parked on a blocking pool
/// thread, which is bounded, and off the main thread by `off_main`, which is
/// what makes it merely slow rather than a frozen wall.
const TRIES: u32 = 2;

/// Long enough for a wifi association to come back, short enough not to be a
/// wait in its own right. Deliberately not a backoff — two attempts have one gap
/// between them, and the real backoff for anything worse than a blip is
/// `FLOOR_MS` and the poll above it.
const RETRY_PAUSE: Duration = Duration::from_millis(1000);

/// Ask, and ask again if the question never arrived.
///
/// The retry is here rather than in `report_with` so that everything above it —
/// the floor, the hush, the cache — goes on seeing one ask per pass, which is
/// what all of them are written against. A blip that heals on the second attempt
/// leaves no trace anywhere; one that does not says how many times it was tried,
/// because "the network is down" and "a packet was dropped" want different
/// things from whoever reads it.
fn ask(token: &Token) -> Result<serde_json::Value, Refusal> {
    asking(RETRY_PAUSE, || ask_once(token))
}

/// The retrying itself, with the network and the waiting both passed in — so
/// what is actually being decided here (which refusals are worth a second go,
/// and what the last one is allowed to claim) is testable without a socket or a
/// second of sleeping.
fn asking(
    pause: Duration,
    mut attempt: impl FnMut() -> Result<serde_json::Value, Refusal>,
) -> Result<serde_json::Value, Refusal> {
    let mut tried = 0;
    loop {
        tried += 1;
        match attempt() {
            Err(r) if r.flaky && tried < TRIES => std::thread::sleep(pause),
            Err(mut r) => {
                if tried > 1 {
                    r.say = format!("{} — tried {tried} times", r.say);
                }
                return Err(r);
            }
            got => return got,
        }
    }
}

fn ask_once(token: &Token) -> Result<serde_json::Value, Refusal> {
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
        /* Nothing answered — a name that would not resolve, a connect that timed
           out, a socket that went away mid-read. `flaky` rather than `fault`
           because there is no server on the other end of this to be polite to,
           and on the wifi this app is actually used on it is the failure most
           likely to be over by the time it has been reported. */
        Err(e) => Err(Refusal::flaky(format!(
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
            .map(|label| {
                let now = now_ms();
                let afar = afar_for(&app, &label, now);
                /* A peer read this account moments ago: that answer is as good
                   as asking, and costs the endpoint nothing. Unless this wall
                   holds one newer still. */
                if let Some(a) = afar.as_ref().filter(|a| now - a.at < SHARED_FRESH_MS) {
                    let held = state.0.lock().ok().and_then(|all| all.get(&label).and_then(|c| c.last.as_ref().map(|r| r.at)));
                    if held.is_none_or(|at| at < a.at) {
                        return Allowance { label, report: Some(a.clone()), fault: None };
                    }
                }
                match pick(report_with(&app, &state, &label), afar) {
                    Ok(report) => Allowance { label, report: Some(report), fault: None },
                    Err(fault) => Allowance { label, report: None, fault: Some(fault) },
                }
            })
            .collect()
    })
    .await
}

/* ── a reading another wall took ───────────────────────────────────────────
 *
 * An account's allowance is the account's, whichever machine asked, so a wall
 * flying with others is told their readings (`flyway/accounts.rs`, by identity,
 * with an age rather than a clock time) and uses one wherever it is fresher than
 * its own — or wherever it has none, which is the case worth the feature: a wall
 * that has not polled an account, or whose sign-in for it has expired, still
 * knows it is at 90%.
 *
 * It comes back as an ordinary `Report`, dated on *this* wall's clock
 * (`at = now − age`) and saying where it was read, so everything downstream —
 * `keptThrough`, `sayStale`, the caps — treats it exactly as a reading taken
 * here that long ago. It is held to `keptThrough`'s own rule before it is
 * handed on: a window that has rolled since it was read is a floor on nothing
 * and is dropped, and so is one naming no reset. A reading with nothing left
 * is not a reading.
 */

/// How fresh a peer's reading must be for this wall to use it instead of
/// asking. The waterfall's own cadence: anything this fresh is what a pass of
/// ours would have found.
const SHARED_FRESH_MS: i64 = 3 * 60_000;

const AFAR_WINDOWS_MOST: usize = 24;
const AFAR_WORD_MOST: usize = 80;

/// This wall's own last reading of one account, for the flyway to say. Never
/// one heard from another wall — those live with the link and are not passed
/// on, since the age they carry is only the reading wall's to vouch for.
pub fn own_reading(app: &AppHandle, label: &str) -> Option<(serde_json::Value, i64)> {
    let state = app.try_state::<Limits>()?;
    let all = state.0.lock().ok()?;
    let r = all.get(label)?.last.as_ref()?;
    Some((serde_json::to_value(r).ok()?, r.at))
}

/// The freshest reading another wall said of the account `label` signs in as.
fn afar_for(app: &AppHandle, label: &str, now: i64) -> Option<Report> {
    let identity = app
        .try_state::<crate::store::Store>()?
        .0
        .lock()
        .ok()
        .and_then(|c| crate::accountsync::key_of(&c, label))
        .filter(|k| crate::flyway::accounts::is_identity(k))?;
    let (host, report, age) = crate::flyway::link::accounting::afar_reading(app, &identity)?;
    afar_report(&report, &host, age, now)
}

/// A reading off the wire, held to this file's shape and `keptThrough`'s rule,
/// dated on this clock. Pure, so what another build may put on this wall is
/// tested here.
fn afar_report(v: &serde_json::Value, host: &str, age_ms: u64, now: i64) -> Option<Report> {
    let r: Report = serde_json::from_value(v.clone()).ok()?;
    let word = |s: &str| crate::clip::preview(&crate::clean::scrub(s.trim()), AFAR_WORD_MOST);
    let windows: Vec<Window> = r
        .windows
        .into_iter()
        .take(AFAR_WINDOWS_MOST)
        .filter(|w| w.used.is_finite() && w.resets_at.is_some_and(|t| t > now))
        .map(|w| Window {
            kind: word(&w.kind),
            group: word(&w.group),
            used: w.used.clamp(0.0, 100.0),
            severity: word(&w.severity),
            resets_at: w.resets_at,
            scope: w.scope.as_deref().map(word),
            active: w.active,
        })
        .collect();
    if windows.is_empty() {
        return None;
    }
    let age = i64::try_from(age_ms).ok()?;
    Some(Report {
        windows,
        overage: r.overage.map(|o| Overage { enabled: o.enabled, used: o.used.filter(|u| u.is_finite()) }),
        at: now.saturating_sub(age),
        source: format!("read on {}", word(host)),
        plan: r.plan.as_deref().map(word),
    })
}

/// This wall's answer against a peer's: the newer of two readings, or the
/// peer's where this wall could not ask — a failed ask is not evidence, and a
/// reading in hand from elsewhere is.
fn pick(own: Result<Report, String>, afar: Option<Report>) -> Result<Report, String> {
    match (own, afar) {
        (Ok(r), Some(a)) if a.at > r.at => Ok(a),
        (Ok(r), _) => Ok(r),
        (Err(_), Some(a)) => Ok(a),
        (Err(f), None) => Err(f),
    }
}

/// How full this wall's allowance is, for the flyway's roster to announce:
/// each account's fullest window, and of those the account with the most room
/// left — since that is where the waterfall would put a new card. `None` when
/// nothing has been read.
///
/// **Only what is already cached, never a request.** The announcement runs on
/// the flyway's tick, and an ask from there would be a second poller of this
/// endpoint behind the floor the widgets keep — the one thing this file's
/// hush exists to stop. A wall nobody is watching the allowance on announces
/// none, which the roster draws as unknown rather than as empty.
pub fn headroom_used(app: &AppHandle) -> Option<u8> {
    let state = app.try_state::<Limits>()?;
    let all = state.0.lock().ok()?;
    all.values()
        .filter_map(|c| c.last.as_ref())
        .filter_map(|r| r.windows.iter().map(|w| w.used).fold(None, |m: Option<f64>, u| Some(m.map_or(u, |m| m.max(u)))))
        .fold(None, |m: Option<f64>, u| Some(m.map_or(u, |m| m.min(u))))
        .map(|u| u.clamp(0.0, 100.0).round() as u8)
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

    /* The token just answered, so it is the moment to ask who it belongs to —
       once a day at most, and never a reason this reading fails. */
    if !label.is_empty() {
        learn_if_due(app, label, &token);
    }

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


/* ── who an account signs in as ────────────────────────────────────────────
 *
 * The one fact the flyway matches an account on across machines
 * (`flyway/accounts.rs`). Labels are local — what *this* machine calls a
 * subscription — so two walls can only agree that `lyss` here is `work` there by
 * asking the account itself.
 *
 * **Not `claude auth status`.** It was probed for exactly this, 2026-10-19
 * against claude 2.1.301, under `CLAUDE_SECURESTORAGE_CONFIG_DIR` set to each
 * store in turn: every store answered the *same* email and org id, hashed
 * af1691… for both `lyss` and `tx-team`, and neither matched what `tx-team`'s
 * own token said it was. The CLI reads the identity out of the shared
 * `~/.claude.json` (`oauthAccount`), which is written by whichever sign-in ran
 * last — so it is a fact about the config directory the stores share, and
 * matching on it would have declared every account on the wall to be one. The
 * credential file names nobody either (`claudeAiOauth` is tokens, two stamps, a
 * plan and a tier).
 *
 * `/api/oauth/profile` with the store's own access token is the source that
 * answers per store: 200 in about 350ms, `account.uuid`, `account.email`,
 * `organization.uuid`, `organization.name`. The identity is the pair of uuids —
 * one login in two organisations is two subscriptions, billed apart.
 *
 * Asked rarely, and only with a token already in hand: once after a sign-in
 * (`learn_identity`, from the panel's `signin:done`), and otherwise after an
 * allowance read that just succeeded with the same token, at most once a day per
 * account (`IDENTITY_EVERY_MS`). An account whose token has expired and that
 * nothing has used since stays unidentified — and therefore unsynced, keeping
 * its own settings — until a card uses it or it is signed in again. That gap is
 * accepted rather than papered over with the label: a guess here moves one
 * subscription's on/off onto another.
 */

const PROFILE: &str = "https://api.anthropic.com/api/oauth/profile";

/// How long a learned identity is trusted before an allowance read asks again.
/// A store is re-signed-in rarely, and `learn_identity` after a sign-in does not
/// wait on this.
const IDENTITY_EVERY_MS: i64 = 24 * 60 * 60_000;

/// Who one credential signs in as.
#[derive(Debug, Clone, PartialEq)]
pub struct Identity {
    /// `<account uuid>:<organisation uuid>`.
    pub key: String,
    pub email: String,
    pub org: String,
}

/// The identity in a profile answer, or `None` if it does not name both uuids.
/// Pure, so the shape is held by a test rather than by a live account.
fn identity_from(doc: &serde_json::Value) -> Option<Identity> {
    let s = |p: &str| doc.pointer(p).and_then(|v| v.as_str()).map(str::trim).unwrap_or("").to_string();
    let key = format!("{}:{}", s("/account/uuid"), s("/organization/uuid"));
    crate::flyway::accounts::is_identity(&key).then(|| Identity {
        key,
        email: s("/account/email"),
        org: s("/organization/name"),
    })
}

fn profile(token: &Token) -> Result<Identity, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(CONNECT_TIMEOUT)
        .timeout_read(READ_TIMEOUT)
        .build();
    let doc: serde_json::Value = agent
        .get(PROFILE)
        .set("Authorization", &format!("Bearer {}", token.value))
        .set("Accept", "application/json")
        .set("anthropic-beta", "oauth-2025-04-20")
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(code, _) => format!("the profile endpoint answered {code}"),
            other => format!("could not reach the profile endpoint: {other}"),
        })?
        .into_json()
        .map_err(|e| format!("unreadable profile: {e}"))?;
    identity_from(&doc).ok_or_else(|| "the profile named no account and organisation".to_string())
}

/// Record who `label` signs in as, and bring its settings up to what the other
/// walls agreed for that identity (`accountsync::adopt_identity`). Announces a
/// change if the row moved or the identity is new.
fn record_identity(app: &AppHandle, label: &str, id: &Identity) -> Result<(), String> {
    let store = app.try_state::<crate::store::Store>().ok_or("the store is not open")?;
    let (new, moved) = {
        let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
        let before = crate::accountsync::key_of(&conn, label).unwrap_or_default();
        let moved = crate::accountsync::adopt_identity(&conn, label, &id.key, &id.email, &id.org, now_ms())?;
        (before != id.key, moved)
    };
    if new || moved {
        crate::accounts::changed(app);
    }
    Ok(())
}

/// After an allowance read that worked: ask who the account is, if nobody has
/// for a day. Failure is silent — the identity is a nicety of the next read,
/// never a reason this one failed.
fn learn_if_due(app: &AppHandle, label: &str, token: &Token) {
    let due = app
        .try_state::<crate::store::Store>()
        .and_then(|s| s.0.lock().ok().map(|c| crate::accountsync::identity_at(&c, label)))
        .is_some_and(|at| now_ms() - at > IDENTITY_EVERY_MS);
    if !due {
        return;
    }
    match profile(token) {
        Ok(id) => {
            if let Err(e) = record_identity(app, label, &id) {
                log::debug!("accounts: could not record who '{label}' is: {e}");
            }
        }
        Err(e) => log::debug!("accounts: could not ask who '{label}' is: {e}"),
    }
}

/// Learn who one account signs in as, now — after a sign-in, when the token is
/// as fresh as it will ever be. Answers whether it was learned; a failure is
/// said rather than thrown, since nothing waits on it but a line in the panel.
#[tauri::command]
pub async fn learn_identity(app: AppHandle, label: String) -> Result<Option<String>, String> {
    crate::off_main(move || learn_now(&app, &label).map(Some)).await?
}

/// The same, blocking — for a thread that is already off the main one, which
/// is where `signin.rs` hears a sign-in finish. Answers the address learned.
pub fn learn_now(app: &AppHandle, label: &str) -> Result<String, String> {
    let token = token(app, Some(label))?;
    let id = profile(&token)?;
    record_identity(app, label, &id)?;
    Ok(id.email)
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
pub const ACCOUNTS_TOOL: &str = "accounts";

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
    match tool {
        ALLOWANCE_TOOL => Some(do_allowance(app, caller)),
        ACCOUNTS_TOOL => Some(do_accounts(app, caller)),
        _ => None,
    }
}

/// Every account on the wall, by the label `spawn` takes.
///
/// `allowance` reads one account — the asking card's — and says how many
/// others there are. That is the right scope for *what can I afford*, and it
/// left an agent with no way to answer *which account should this card go on*:
/// `spawn` takes a label, and the only place a label appeared was a refusal.
/// This is the other half, and it is deliberately the cheap half.
///
/// **No network.** The figures are whatever `Limits` already holds — the
/// waterfall polls every usable account about once a minute, so on a wall that
/// manages accounts they are rarely old, and each is dated so a stale one says
/// so. Asking the endpoint for every account on one tool call would be N
/// requests against `FLOOR_MS`'s one-per-minute bargain, for a listing.
///
/// **Figures, not a verdict.** Whether an account has room is the user's caps
/// against these percentages, and `accounts.ts::choose` is the one place that
/// weighs them. A "has room" computed here would be a second waterfall, and the
/// one that drifts. So this reports and the answer says the wall decides.
pub fn accounts_schema() -> serde_json::Value {
    serde_json::json!({
        "name": ACCOUNTS_TOOL,
        "description":
            "List the Claude accounts this wall can put a card on, in the order work \
             falls through them: each one's label, its priority tier, whether it can \
             take work at all (switched on and signed in), the last reading of how much \
             of it is used, and which one *this* card is on. Costs nothing — no request \
             is made, the figures are the wall's last poll and each says how old it is.\n\n\
             Read it before passing `account` to `spawn`, which takes one of these labels. \
             Leave `account` out unless the user asked for one: the ladder already puts \
             new work on the lowest tier with room, using caps the user set that this \
             listing does not apply. For what *this* card can afford, `allowance` is the \
             fresher answer.",
        "inputSchema": { "type": "object", "properties": {} }
    })
}

/// One account as the listing draws it.
struct Seat<'a> {
    label: &'a str,
    priority: i64,
    enabled: bool,
    signed_in: bool,
    /// The last reading for it — this wall's, or another wall's where that is
    /// fresher (`pick`), which then says where it was read.
    reading: Option<&'a Report>,
    /// A retired copy of another machine's sign-in (`accounts::is_copy`).
    copied: bool,
    /// Who it signs in as, where that is known.
    who: Option<&'a str>,
    /// The last change to its synced settings made on another wall, said.
    synced: Option<String>,
}

fn do_accounts(app: &AppHandle, caller: &str) -> String {
    let me = crate::flyway::key::host_name();
    type Extra = (String, Option<String>);
    type Read = (Vec<crate::accounts::Seat>, Option<String>, std::collections::HashMap<String, Extra>);
    let (seats, mine, extra): Read = app
        .try_state::<crate::store::Store>()
        .and_then(|s| {
            s.0.lock().ok().map(|conn| {
                let seats = crate::accounts::registry(app, &conn);
                /* Who each signs in as, and the last change another wall made
                   to it — the synced half, read under the same lock. */
                let extra = seats
                    .iter()
                    .map(|seat| {
                        let email: String = conn
                            .query_row(
                                "SELECT identity_email FROM account WHERE label = ?1",
                                rusqlite::params![seat.label],
                                |r| r.get(0),
                            )
                            .unwrap_or_default();
                        let last = crate::accountsync::registers_of(&conn, &seat.label)
                            .into_iter()
                            .filter(|r| !r.host.eq_ignore_ascii_case(&me))
                            .max_by_key(|r| r.at)
                            .map(|r| format!("{} last set on {} {} ago", r.field, r.host, soon(now_ms() - r.at)));
                        (seat.label.clone(), (email, last))
                    })
                    .collect();
                (seats, crate::store::account_of(&conn, caller), extra)
            })
        })
        .unwrap_or((Vec::new(), None, std::collections::HashMap::new()));
    /* Cloned out under the lock and read after it, so a slow format never holds
       the mutex every poll and every card's `allowance` goes through. */
    let held: std::collections::HashMap<String, Report> = app
        .state::<Limits>()
        .0
        .lock()
        .map(|all| {
            all.iter()
                .filter_map(|(k, c)| c.last.clone().map(|r| (k.clone(), r)))
                .collect()
        })
        .unwrap_or_default();
    /* Another wall's reading where it is fresher than this wall's, or where
       this wall has none — still no request, since the link already holds it. */
    let now = now_ms();
    let held: std::collections::HashMap<String, Report> = seats
        .iter()
        .filter_map(|s| {
            let own = held.get(&s.label).cloned().ok_or_else(String::new);
            pick(own, afar_for(app, &s.label, now)).ok().map(|r| (s.label.clone(), r))
        })
        .collect();
    let rows: Vec<Seat> = seats
        .iter()
        .map(|s| {
            let (email, synced) = extra.get(&s.label).cloned().unwrap_or_default();
            Seat {
                label: &s.label,
                priority: s.priority,
                enabled: s.enabled,
                signed_in: s.signed_in,
                reading: held.get(&s.label),
                copied: s.copied,
                who: extra.get(&s.label).map(|(e, _)| e.as_str()).filter(|_| !email.is_empty()),
                synced,
            }
        })
        .collect();
    say_accounts(&rows, mine.as_deref(), now_ms())
}

/// The listing, pure. `mine` is the asking card's account, or `None` for the
/// CLI's own sign-in, which is none of these rows.
fn say_accounts(rows: &[Seat], mine: Option<&str>, now: i64) -> String {
    if rows.is_empty() {
        return "This wall manages no accounts: every card runs as whoever Claude Code is \
                signed in as on this machine, so there is nothing to choose between — \
                leave `account` out of `mcp__skein__spawn`."
            .into();
    }
    let mut out = String::from(
        "Accounts on this wall, in the order work falls through them. A lower priority is \
         spent first; accounts sharing one share the work.\n",
    );
    for r in rows {
        let standing = match (r.enabled, r.signed_in) {
            (false, _) => "switched off — takes no work".to_string(),
            (true, false) => "not signed in — takes no work".to_string(),
            (true, true) if r.copied => format!("takes no work — {}", crate::accounts::COPIED),
            (true, true) => match r.reading {
                None => "usable, not read yet".to_string(),
                Some(rep) if rep.windows.is_empty() => {
                    format!("usable, no windows touched (read {} ago)", soon(now - rep.at))
                }
                Some(rep) => {
                    let used = rep
                        .windows
                        .iter()
                        .map(|w| format!("{} {:.0}%", w.kind, w.used))
                        .collect::<Vec<_>>()
                        .join(", ");
                    let place = rep.source.strip_prefix("read on ").map(|h| format!(" on {h}")).unwrap_or_default();
                    format!("usable, {used} used (read{place} {} ago)", soon(now - rep.at))
                }
            },
        };
        let here = if Some(r.label) == mine { " — this card is on it" } else { "" };
        let who = r.who.map(|w| format!(" · signs in as {w}")).unwrap_or_default();
        let synced = r.synced.as_deref().map(|s| format!(" · {s}")).unwrap_or_default();
        out.push_str(&format!(
            "- {} · priority {} · {standing}{here}{who}{synced}\n",
            r.label, r.priority
        ));
    }
    if mine.is_none() {
        out.push_str("This card is on Claude Code's own sign-in, which is none of these.\n");
    }
    out.push_str(
        "\nTo start a card on one, pass its label as `account` to `mcp__skein__spawn`; left out, the \
         ladder picks. These are figures, not a verdict: whether an account has room is the \
         user's caps against them, which the wall applies and this listing does not — and a \
         card named onto an account without room goes down the ladder anyway. On/off and \
         caps are the same on every wall of the flyway that knows an account; to change one, \
         `mcp__skein__set_account` asks the user.",
    );
    out
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
    let others: Vec<String> = usable
        .into_iter()
        .filter(|l| Some(l.as_str()) != label.as_deref())
        .collect();

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
                elsewhere(&others)
            )
        }
    };

    let mut out = String::new();
    /* Which subscription this is a reading of. Absent before, and unmissed only
       because there was only ever one answer; now that the card's own account is
       what gets asked, a percentage with no name on it is a percentage the user
       cannot check. `source` is where the credential was found and never a
       fragment of it — the rule the rest of this file keeps. */
    out.push_str(&scope_line(&report.source, &others));
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
    format!("{out}\n{day}\n\n{}", advice_for(worst, others.len()))
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
///
/// **Named, not only counted.** A count told an agent the wall was bigger than
/// this reading and left it unable to do anything about it — `spawn` takes an
/// `account`, and a label an agent has never seen is one it can only guess at.
/// The labels are the user's own names for their subscriptions and carry no
/// credential, so there is nothing to withhold; the `accounts` tool is where
/// the rest of each one is.
fn elsewhere(others: &[String]) -> String {
    let named = others.join(", ");
    match others.len() {
        0 => String::new(),
        1 => format!(
            " One other account on this wall is usable ({named}), and nothing above is a \
             reading of it — `mcp__skein__accounts` lists every account and its last reading."
        ),
        n => format!(
            " {n} other accounts on this wall are usable ({named}), and nothing above is a \
             reading of any of them — `mcp__skein__accounts` lists every account and its last \
             reading."
        ),
    }
}

/// Whose figures these are, and whether they are the wall's -- the first line of
/// the answer, so the scope is established before any number is.
fn scope_line(source: &str, others: &[String]) -> String {
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

    fn afar(windows: serde_json::Value) -> serde_json::Value {
        serde_json::json!({ "windows": windows, "overage": null, "at": 1, "source": "the 'lyss' account", "plan": "team" })
    }

    /// A peer's reading comes back dated on this clock and naming where it
    /// was read, with `keptThrough`'s rule already applied: a window that has
    /// rolled, or names no reset, is a floor on nothing.
    #[test]
    fn a_reading_from_another_wall_is_dated_here_and_thinned() {
        let now = 10_000_000;
        let v = afar(serde_json::json!([
            { "kind": "session", "group": "session", "used": 90.4, "severity": "normal", "resetsAt": now + 60_000, "scope": null, "active": true },
            { "kind": "weekly_all", "group": "weekly", "used": 50, "severity": "normal", "resetsAt": now - 1, "scope": null, "active": false },
            { "kind": "weekly_scoped", "group": "weekly", "used": 0, "severity": "normal", "resetsAt": null, "scope": "Fable", "active": false },
            { "kind": "x", "group": "session", "used": 140, "severity": "normal", "resetsAt": now + 1, "scope": null, "active": false }
        ]));
        let r = afar_report(&v, "AU-LT-288", 120_000, now).unwrap();
        assert_eq!(r.at, now - 120_000);
        assert_eq!(r.source, "read on AU-LT-288");
        assert_eq!(r.windows.len(), 2);
        assert_eq!(r.windows[0].used, 90.4);
        assert_eq!(r.windows[1].used, 100.0, "clamped, never past the real limit");
        /* Nothing left is not a reading. */
        let rolled = afar(serde_json::json!([
            { "kind": "session", "group": "session", "used": 90, "severity": "normal", "resetsAt": now - 5, "scope": null, "active": true }
        ]));
        assert!(afar_report(&rolled, "x", 0, now).is_none());
        assert!(afar_report(&serde_json::json!({ "windows": "nope" }), "x", 0, now).is_none());
    }

    /// The newer of two readings, and a peer's wherever this wall could not
    /// ask — a failed ask is not evidence.
    #[test]
    fn the_fresher_reading_wins_and_a_fault_yields_to_one_in_hand() {
        let now = 10_000_000;
        let at = |t: i64| {
            let mut r = afar_report(
                &afar(serde_json::json!([{ "kind": "session", "group": "session", "used": 1, "severity": "normal", "resetsAt": now + 9, "scope": null, "active": true }])),
                "h",
                0,
                t,
            )
            .unwrap();
            r.at = t;
            r
        };
        assert_eq!(pick(Ok(at(5)), Some(at(9))).unwrap().at, 9);
        assert_eq!(pick(Ok(at(9)), Some(at(5))).unwrap().at, 9);
        assert_eq!(pick(Err("down".into()), Some(at(5))).unwrap().at, 5);
        assert!(pick(Err("down".into()), None).is_err());
    }

    /// The profile answer's shape, as `/api/oauth/profile` returned it on
    /// 2026-10-19 (values invented): the identity is both uuids, and an answer
    /// missing either names nobody rather than half an account.
    #[test]
    fn an_identity_is_the_account_and_its_organisation() {
        let doc = serde_json::json!({
            "account": { "uuid": "8ebb2352-1111-4000-8000-000000000001", "email": "l@example.com", "full_name": "L" },
            "organization": { "uuid": "10340709-2222-4000-8000-000000000002", "name": "Studio", "organization_type": "claude_team" },
            "application": { "uuid": "ffff", "name": "Claude Code" }
        });
        let id = identity_from(&doc).unwrap();
        assert_eq!(id.key, "8ebb2352-1111-4000-8000-000000000001:10340709-2222-4000-8000-000000000002");
        assert_eq!(id.email, "l@example.com");
        assert_eq!(id.org, "Studio");
        assert!(identity_from(&serde_json::json!({ "account": { "uuid": "abc" } })).is_none());
        assert!(identity_from(&serde_json::json!({ "organization": { "uuid": "abc" } })).is_none());
        assert!(identity_from(&serde_json::json!({ "account": { "uuid": "x y" }, "organization": { "uuid": "abc" } })).is_none());
    }

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

    /// Two attempts, no sleeping, and a counter to say what really happened.
    fn tried(answers: Vec<Result<serde_json::Value, Refusal>>) -> (Result<serde_json::Value, Refusal>, usize) {
        let mut left = answers.into_iter();
        let mut n = 0;
        let got = asking(Duration::ZERO, || {
            n += 1;
            left.next().expect("asked more times than the test allowed for")
        });
        (got, n)
    }

    #[test]
    fn a_question_that_never_arrived_is_asked_again() {
        /* The failure this is written for: one dropped packet on flaky wifi took
           an account to `ready · unmeasured` for three minutes, with your caps
           off for all of it. Nothing was refused — nothing was reached. */
        let (got, n) = tried(vec![
            Err(Refusal::flaky("could not reach the allowance endpoint: timed out")),
            Ok(serde_json::json!({"limits": []})),
        ]);
        assert!(got.is_ok(), "the second attempt is the answer");
        assert_eq!(n, 2);
    }

    #[test]
    fn a_refusal_from_the_server_is_never_asked_again() {
        /* The whole line this feature stands on. A `429` is the one answer that
           asking again makes worse, and a `5xx` is the server saying the same
           thing; both hush instead. A stale sign-in recovers by itself and the
           next pass is what notices, so it is not worth a second connect
           either. */
        let (got, n) = tried(vec![Err(Refusal::wait("rate limited", None))]);
        assert_eq!(n, 1);
        assert!(got.is_err());

        let (_, n) = tried(vec![Err(Refusal::fault("the sign-in has expired"))]);
        assert_eq!(n, 1);
    }

    #[test]
    fn giving_up_says_how_many_times_it_tried() {
        /* "the network is down" and "a packet was dropped" want different things
           from whoever reads the row, and the count is the only thing that tells
           them apart. */
        let (got, n) = tried(vec![
            Err(Refusal::flaky("could not reach the allowance endpoint: timed out")),
            Err(Refusal::flaky("could not reach the allowance endpoint: timed out")),
        ]);
        assert_eq!(n, TRIES as usize, "and no more than that");
        let say = got.err().unwrap().say;
        assert!(say.contains("tried 2 times"), "{say}");

        /* And a refusal that was never retried claims nothing about retrying —
           the sentence on the row is the server's own words and no more. */
        let (got, _) = tried(vec![Err(Refusal::wait("rate limited", None))]);
        assert_eq!(got.err().unwrap().say, "rate limited");
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
        let alone = scope_line("the 'personal' account", &[]);
        assert!(
            alone.starts_with("Account: the 'personal' account."),
            "{alone}"
        );
        assert!(!alone.contains("usable"), "nothing to disclaim: {alone}");

        let one = scope_line("the 'personal' account", &["work".into()]);
        assert!(one.contains("One other account"), "{one}");
        assert!(one.contains("(work)"), "the label is what spawn takes: {one}");

        let many = scope_line("the CLI's sign-in", &["a".into(), "b".into(), "c".into()]);
        assert!(many.contains("3 other accounts"), "{many}");
        assert!(many.contains("(a, b, c)"), "{many}");
        assert!(many.contains("nothing above is a reading"), "{many}");
        assert!(many.contains("`mcp__skein__accounts`"), "and where the rest is: {many}");

        assert!(elsewhere(&[]).is_empty());
    }

    /// The listing names every account by the label `spawn` takes, says which
    /// can take work and which one the caller is on, and dates every figure.
    #[test]
    fn the_accounts_listing_names_what_spawn_can_take() {
        let read = Report {
            windows: vec![Window {
                kind: "session".into(),
                group: "session".into(),
                used: 42.4,
                severity: "normal".into(),
                resets_at: None,
                scope: None,
                active: true,
            }],
            overage: None,
            at: 1_000,
            source: "the 'work' account".into(),
            plan: None,
        };
        let rows = [
            Seat { label: "work", priority: 1, enabled: true, signed_in: true, reading: Some(&read), copied: false, who: Some("w@example.com"), synced: None },
            Seat { label: "spare", priority: 1, enabled: true, signed_in: true, reading: None, copied: false, who: None, synced: None },
            Seat { label: "off", priority: 2, enabled: false, signed_in: true, reading: None, copied: false, who: None, synced: Some("enabled last set on AU-LT-288 3m ago".into()) },
            Seat { label: "new", priority: 3, enabled: true, signed_in: false, reading: None, copied: false, who: None, synced: None },
            Seat { label: "copy", priority: 3, enabled: true, signed_in: true, reading: None, copied: true, who: None, synced: None },
        ];
        let said = say_accounts(&rows, Some("work"), 1_000 + 120_000);
        assert!(said.contains("- work · priority 1 · usable, session 42% used (read 2m ago) — this card is on it · signs in as w@example.com"), "{said}");
        assert!(said.contains("- off · priority 2 · switched off — takes no work · enabled last set on AU-LT-288 3m ago"), "{said}");
        assert!(said.contains("- copy · priority 3 · takes no work — this sign-in was copied"), "{said}");
        assert!(said.contains("mcp__skein__set_account"), "{said}");
        assert!(said.contains("- spare · priority 1 · usable, not read yet\n"), "{said}");
        assert!(said.contains("- off · priority 2 · switched off"), "{said}");
        assert!(said.contains("- new · priority 3 · not signed in"), "{said}");
        assert!(said.contains("`account` to `mcp__skein__spawn`"), "{said}");
        assert!(said.contains("not a verdict"), "{said}");
        assert!(!said.contains("own sign-in"), "{said}");

        let global = say_accounts(&rows, None, 2_000);
        assert!(global.contains("Claude Code's own sign-in, which is none of these"), "{global}");
        assert!(!global.contains("this card is on it"), "{global}");

        let none = say_accounts(&[], None, 0);
        assert!(none.contains("manages no accounts"), "{none}");
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
