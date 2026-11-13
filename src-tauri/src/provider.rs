//! Providers: a card that runs on an agent service other than the subscription
//! Claude Code is signed in as. DeepSeek first.
//!
//! **A provider is not an account and holds no credential store.** It is a
//! sentinel in `conversation.account_label`, exactly as `@credits` is
//! (`credits.rs`), and for the same reason: the column already answers "whose
//! money does this card spend", and that question has a third kind of answer
//! now. `accounts::is_label` refuses `@`, so no registered account can ever
//! collide with one.
//!
//! **Why DeepSeek needs no second event pipeline.** Its Anthropic-compatible
//! endpoint speaks the same Messages API the CLI already speaks
//! (`https://api.deepseek.com/anthropic`), so a provider card is the *same*
//! `claude --print` child Volery has always spawned — same stream-json, same
//! sessions, same `--resume`, same hooks — with the environment pointed
//! somewhere else. That is the whole of the seam, and it is why a card can be
//! put on DeepSeek without a model adapter, a second supervisor, or a schema
//! change. Anything that does *not* speak the Anthropic API (Codex, Gemini)
//! would need that adapter and is deliberately not pretended to here.
//!
//! **The key is read from the vault at spawn**, per `creds.rs`, and never
//! travels. The alternative — a project `.claude/settings.json` carrying
//! `ANTHROPIC_AUTH_TOKEN` — was probed working (2026-11-04) and is a plaintext
//! secret in a repository; the environment of a child process needs debug
//! rights to read.
//!
//! **The store is pointed at an empty directory.** With a token present the CLI
//! uses it, so the store changes nothing; it is there for a build that one day
//! stops honouring the variable, which would otherwise fall through to the
//! machine's Claude sign-in and quietly spend a subscription while the card says
//! deepseek. `credits::apply` strikes the identical bargain.

use std::process::Command;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

/// The sentinel `conversation.account_label` holds for a DeepSeek card. Kept in
/// step with `providers.ts::DEEPSEEK` by `test/providers.test.ts`, which reads
/// this file.
pub const DEEPSEEK: &str = "@deepseek";

/// One provider, as everything that has to agree about it.
pub struct Provider {
    /// What the store holds and the wall compares against.
    pub label: &'static str,
    /// The `creds.rs` service its key lives under.
    pub key: &'static str,
    /// What a card and a menu call it.
    pub name: &'static str,
    /// Where the CLI sends its requests.
    pub base_url: &'static str,
    /// **The model a card with no `--model` asks for, as a Claude alias.** The
    /// CLI validates model ids locally and refuses one it does not know
    /// (`[claude-code:unrecognized_model]`), so the provider's own names never
    /// go on the wire: DeepSeek maps `claude-opus*` to `deepseek-v4-pro` and
    /// everything else to `deepseek-flash` server-side. See [`cli_model`].
    pub model: &'static str,
}

const PROVIDERS: &[Provider] = &[Provider {
    label: DEEPSEEK,
    key: "deepseek",
    name: "deepseek",
    base_url: "https://api.deepseek.com/anthropic",
    /* `sonnet` is recognised by the CLI and mapped by DeepSeek to `flash`, the
       everyday model. A card that wants the pro end uses `opus`, which DeepSeek
       maps to `deepseek-v4-pro` (`providers.ts::providerCliModel`). */
    model: "sonnet",
}];

/// The alias the CLI is actually given for a provider card.
///
/// **The provider's names are its own; Claude Code's are the wire's.** The CLI
/// resolves and validates `--model` before any request is made, and a model it
/// has never heard of dies as `[claude-code:unrecognized_model]` — observed on
/// 2026-11-04, the first live card, with `deepseek-v4-pro`. DeepSeek's
/// Anthropic-compatible endpoint maps Claude names itself: `claude-opus*` →
/// `deepseek-v4-pro`, everything else (`claude-sonnet*`, `claude-haiku*`) →
/// `deepseek-flash`. So the wall stores and draws the provider's names and
/// hands the child a family alias that both sides understand.
pub fn cli_model(p: &'static Provider, model: Option<&str>) -> String {
    let bare = model
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
        .split('[')
        .next()
        .unwrap_or("")
        .to_string();
    if bare.contains("v4-pro") || bare.contains("opus") {
        "opus".into()
    } else if bare.contains("flash")
        || bare.contains("sonnet")
        || bare.contains("haiku")
        || bare.contains("fable")
    {
        "sonnet".into()
    } else {
        p.model.into()
    }
}

/// The provider a label names, or `None` for an ordinary account, the CLI's own
/// sign-in, or `@credits`.
pub fn of(label: Option<&str>) -> Option<&'static Provider> {
    let label = label?.trim();
    PROVIDERS.iter().find(|p| p.label == label)
}

pub fn is_provider(label: Option<&str>) -> bool {
    of(label).is_some()
}

/// A provider by any of the names a caller might have: the menu id, the wire
/// name, the vault key, or the `@` sentinel. The keyring knows `deepseek`, a
/// card knows `@deepseek`, and a command should not make the caller translate.
pub fn named(name: &str) -> Option<&'static Provider> {
    let n = name.trim();
    PROVIDERS
        .iter()
        .find(|p| p.key == n || p.name == n || p.label == n || p.label.trim_start_matches('@') == n)
}

/// Put a child on the provider's endpoint, or refuse to spawn it.
///
/// The ordering of the removals matters: `ANTHROPIC_API_KEY` outranks a token
/// and `CLAUDE_CODE_OAUTH_TOKEN` outranks the store, so both are taken off
/// before the provider's own credential is set. The empty store is the second
/// lock on the same door — see this module's header.
pub fn apply(app: &AppHandle, cmd: &mut Command, p: &'static Provider) -> Result<(), String> {
    let key = crate::creds::token(p.key)
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
        .ok_or_else(|| {
            format!(
                "no {} API key is stored, so this card cannot run on {} — add one in the \
                 keyring (space then o)",
                p.name, p.name
            )
        })?;
    cmd.env("ANTHROPIC_BASE_URL", p.base_url);
    cmd.env("ANTHROPIC_AUTH_TOKEN", key);
    /* A Claude alias, not the provider's name — the CLI validates `--model`
       and the env default before a request, and refuses an id it does not know.
       DeepSeek maps the family server-side. See [`cli_model`]. */
    cmd.env("ANTHROPIC_MODEL", p.model);
    cmd.env("CLAUDE_CODE_SUBAGENT_MODEL", p.model);
    /* DeepSeek's recommendation for Claude Code: compact at 75% of the 1M
       window. Volery has its own compaction, and this is the CLI's trigger —
       left at its default it fires at a Claude-sized fraction. */
    cmd.env("CLAUDE_CODE_AUTO_COMPACT_WINDOW", "786432");
    /* DeepSeek's Anthropic endpoint cannot round-trip its own thinking blocks
       through a tool-use history: the next request is refused with
       `content[].thinking … must be passed back`, and Claude Code's stored
       *Claude* blocks are not DeepSeek's format either. Thinking off is the one
       setting that makes a DeepSeek turn replayable; the CLI's own refusal text
       names this variable as the way to turn it back on. A card that moves back
       to Claude keeps the thinking already in the shared session file — nothing
       here touches the transcript. */
    cmd.env("MAX_THINKING_TOKENS", "0");
    /* **Claude Code 2.1.286+ can inline a deferred tool's whole schema in a
       system message**, as a `tool_definition` content block, under the
       `inline-tools-2026-09-15` beta. DeepSeek's Anthropic endpoint understands
       `tool_reference` and not `tool_definition`, and its 422 does not match the
       CLI's own fallback (which looks for `Input tag 'tool_definition'`), so the
       card is stuck rather than downgrading. This is the documented override
       (`CLAUDE_CODE_INLINE_TOOLS`, 2.1.280+); `0` makes the CLI keep tool search
       on and send references, which DeepSeek does understand. Probed against
       this machine's 2.1.318: with `1` the request carries
       `inline-tools-2026-09-15`, with `0` it does not. See
       https://github.com/deepseek-ai/DeepSeek-V3/issues/1701. */
    cmd.env("CLAUDE_CODE_INLINE_TOOLS", "0");
    /* A provider card must not talk to Anthropic at all. The CLI's own update
       checks, telemetry and model-list fetches are not this card's business,
       and with a DeepSeek token they would fail somewhere two hops from the
       cause. */
    cmd.env("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1");
    cmd.env("CLAUDE_SECURESTORAGE_CONFIG_DIR", empty_store(app)?);
    cmd.env_remove("ANTHROPIC_API_KEY");
    cmd.env_remove("CLAUDE_CODE_OAUTH_TOKEN");
    cmd.env_remove("CLAUDE_CODE_ENTRYPOINT");
    Ok(())
}

/// Whether a provider can be moved onto now: its key is in the vault. The
/// front end asks before it ends a child, so a move without a key refuses
/// while the card is still running rather than after it has gone dormant.
#[tauri::command]
pub fn provider_ready(name: String) -> Result<String, String> {
    let p = named(&name).ok_or_else(|| format!("there is no provider called {name}"))?;
    if crate::creds::token(p.key)
        .map(|k| k.trim().is_empty())
        .unwrap_or(true)
    {
        return Err(format!(
            "no {} API key is stored, so this card cannot move to {} — add one in the keyring (space then o)",
            p.name, p.name
        ));
    }
    Ok(p.label.to_string())
}

/// The tool a card uses to move its own conversation to another service.
pub const SET_PROVIDER_TOOL: &str = "set_provider";

pub fn set_provider_schema() -> serde_json::Value {
    serde_json::json!({
        "name": SET_PROVIDER_TOOL,
        "description":
            "Move **this conversation** onto claude code or deepseek, and keep going. The card's \
             process ends and comes back against the same session — transcript, tools, files and \
             plans stay, and claude's thinking is still in the session when it returns. The move \
             happens after this turn's result, so nothing being written now is lost. Use it when \
             the work has outgrown the balance it is on, or to go back to the subscription. \
             Which service or model is worth moving to is a measurement rather than a guess: \
             `mcp__skein__models` gives the readings for this kind of work, with their sources, \
             dates and prices.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "provider": {
                    "type": "string",
                    "enum": ["claude", "deepseek"],
                    "description": "claude for the subscription, deepseek for its own balance. A \
                                    provider's key must already be in the keyring."
                }
            },
            "required": ["provider"],
            "additionalProperties": false
        }
    })
}

/// The tool, as `ask.rs` calls it — `docket::writes`' contract.
///
/// It does not end the child here: the call is inside a turn, and a process
/// killed from under its own tool call would never deliver the answer. It
/// emits the request to the front end, which holds it until this turn's
/// `result` and then does the stop-and-resume (`Skein.setProvider`).
pub(crate) fn writes(
    app: &AppHandle,
    caller: &str,
    tool: &str,
    args: &serde_json::Value,
) -> Option<crate::docket::Writing> {
    use crate::docket::Writing;
    if tool != SET_PROVIDER_TOOL {
        return None;
    }
    let asked = args
        .get("provider")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .unwrap_or("");
    if asked.is_empty() {
        return Some(Writing::Now(
            "name a provider: `claude` or `deepseek`. Nothing was moved.".into(),
        ));
    }
    let target = if asked.eq_ignore_ascii_case("claude") {
        "claude".to_string()
    } else {
        let Some(p) = named(asked) else {
            return Some(Writing::Now(format!(
                "there is no provider called {asked:?} — `claude` or `deepseek`. Nothing was moved."
            )));
        };
        if crate::creds::token(p.key)
            .map(|k| k.trim().is_empty())
            .unwrap_or(true)
        {
            return Some(Writing::Now(format!(
                "no {} API key is stored, so this card cannot move to {} — add one in the keyring (space then o). Nothing was moved.",
                p.name, p.name
            )));
        }
        p.key.to_string()
    };
    if caller.trim().is_empty() {
        return Some(Writing::Now("this card has no id on the wall, so nothing was moved.".into()));
    }
    use tauri::Emitter;
    if app
        .emit(
            "provider:move",
            serde_json::json!({ "id": caller, "provider": target }),
        )
        .is_err()
    {
        return Some(Writing::Now(
            "the wall could not be told to move this card. Nothing was moved.".into(),
        ));
    }
    Some(Writing::Now(format!(
        "moving to {target} after this turn finishes — the same session resumes there. The move is the wall's to make, so carry on until the turn ends."
    )))
}

/// Take a provider's environment off a child that must not inherit it.
///
/// **A card's environment is inherited by everything it starts** — the Bash and
/// PowerShell tools, and a lab wall launched from one of them (`bun run lab`,
/// the documented way to develop a migration). Without this, a Claude card on a
/// wall started from a DeepSeek card inherits the DeepSeek base URL and bearer
/// token, which outrank its account store exactly as `ANTHROPIC_API_KEY` does:
/// it would spend DeepSeek's balance while the wall draws it on a subscription.
/// `credits::withhold`'s argument, one provider over, and the reason it calls
/// this.
pub fn withhold(cmd: &mut Command) {
    for name in [
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "CLAUDE_CODE_SUBAGENT_MODEL",
        "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
        /* The inline-tools override `apply` uses to keep DeepSeek's endpoint
           from seeing `tool_definition`. Inherited by a Claude card it would
           turn a Claude feature off for the rest of the wall. */
        "CLAUDE_CODE_INLINE_TOOLS",
        /* Thinking is off for a provider card (`apply`); an ordinary card
           inheriting the switch would quietly stop thinking for good. */
        "MAX_THINKING_TOKENS",
        /* The empty store `apply` points at. Inherited, it would make an
           ordinary card report `authMethod: "none"` on a wall it did not start
           on. The CLI's own sign-in (no variable) is what an ordinary card
           means. */
        "CLAUDE_SECURESTORAGE_CONFIG_DIR",
    ] {
        cmd.env_remove(name);
    }
}

/// An empty credential store, for the half of `apply`'s bargain a variable
/// cannot make: a CLI that ignored the token would answer `authMethod: "none"`
/// rather than quietly using the machine's sign-in.
fn empty_store(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("no local data dir: {e}"))?
        .join("provider-store");
    std::fs::create_dir_all(&dir).map_err(|e| format!("provider store: {e}"))?;
    Ok(dir)
}

/* ── the balance, and the wall's own cap ────────────────────────────────── */

/// DeepSeek's own reading of the account, from `GET /user/balance`.
///
/// **This is the only place the amount left is knowable.** DeepSeek publishes
/// no allowance endpoint of the Anthropic kind — no five-hour window, no
/// percentage — so the answer to "what can this key still spend" is a balance
/// in the account's currency. `available` is DeepSeek's own yes/no, which is
/// what a card should refuse on.
#[derive(Debug, Clone, Serialize)]
pub struct Balance {
    pub available: bool,
    pub currency: String,
    pub total: f64,
    pub granted: f64,
    pub topped_up: f64,
}

/// The keyring's whole reading: what the account holds, what this wall's cards
/// have spent since the cap started, and the cap itself.
///
/// `limit == 0` is no cap. `balance` and `fault` are exclusive: the network is
/// allowed to fail without hiding the local spend, which is the half that still
/// answers "how close am I to the limit I set".
#[derive(Debug, Clone, Serialize)]
pub struct Reading {
    pub provider: String,
    pub spent: f64,
    pub limit: f64,
    pub from: i64,
    pub balance: Option<Balance>,
    pub fault: Option<String>,
}

fn number(v: &serde_json::Value, key: &str) -> f64 {
    v.get(key)
        .and_then(|x| match x {
            serde_json::Value::String(s) => s.parse::<f64>().ok(),
            serde_json::Value::Number(n) => n.as_f64(),
            _ => None,
        })
        .unwrap_or(0.0)
}

/// Read the balance with the provider's own key. One authenticated GET, on the
/// panel's demand and never on a timer — the same rule `creds.rs` states for
/// every probe, and the reason there is no capacity spent here when nobody is
/// looking.
fn fetch_balance(p: &'static Provider) -> Result<Balance, String> {
    let key = crate::creds::token(p.key)
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
        .ok_or_else(|| format!("no {} API key is stored — add one above", p.name))?;
    let res = crate::forge::agent()
        .get("https://api.deepseek.com/user/balance")
        .set("Authorization", &format!("Bearer {key}"))
        .call();
    match res {
        Ok(res) => {
            let v: serde_json::Value = res
                .into_json()
                .map_err(|e| format!("unreadable answer from {}: {e}", p.name))?;
            let infos = v
                .get("balance_infos")
                .and_then(|b| b.as_array())
                .cloned()
                .unwrap_or_default();
            /* USD where the account holds both; otherwise the first currency,
               because a balance is still a balance and the label says which. */
            let info = infos
                .iter()
                .find(|i| i.get("currency").and_then(|c| c.as_str()) == Some("USD"))
                .or_else(|| infos.first())
                .ok_or_else(|| format!("{} answered no balance at all", p.name))?;
            Ok(Balance {
                available: v.get("is_available").and_then(|b| b.as_bool()).unwrap_or(false),
                currency: info
                    .get("currency")
                    .and_then(|c| c.as_str())
                    .unwrap_or("USD")
                    .to_string(),
                total: number(info, "total_balance"),
                granted: number(info, "granted_balance"),
                topped_up: number(info, "topped_up_balance"),
            })
        }
        Err(ureq::Error::Status(code, res)) => Err(format!(
            "{} answered {code}{}",
            p.name,
            crate::creds::trailing_anthropic(res.into_string().unwrap_or_default())
        )),
        Err(e) => Err(format!("could not reach {}: {e}", p.name)),
    }
}

/// What the voice is told it is, and the app it speaks for.
///
/// **The prompt has to carry the app, because no model has heard of it.** The
/// first version described only the voice's manners, and asked "hello, how do
/// I use this app, what can you do for me" it answered *"I'm Volery's voice on
/// your phone, so you can just talk to me and I'll answer questions, explain
/// things, and think through problems with you"* (probed against
/// `deepseek-flash` 2026-11-11). Fluent, and a description of nothing this app
/// does: no wall, no cards, nothing read aloud. A fact about this machine
/// cannot be in a model's training data, so every one the voice needs is here.
///
/// **The facts are the stable half of the product on purpose.** What a card
/// is, what the phone can and cannot do, and where the guide lives. It does
/// not restate the tutorial's copy; it points at the row that holds it, so a
/// slide rewritten in `Tutorial.kt` cannot leave this file telling a different
/// story.
///
/// It is 238 input tokens a question, measured, and a question is asked by a
/// person pressing a bird rather than by anything on a clock. The last
/// sentence is the one that keeps a wrong answer from sounding like a right
/// one: asked how many cards a wall holds, the grounded voice answered "I'm
/// not sure, the introduction I have does not say" rather than inventing a
/// number somebody would act on.
///
/// **A request for work has two ways to be answered wrongly, and both were
/// found by asking.** "create a simulation in python" was answered with advice
/// and no way to act on it, so the prompt now carries the form a spoken
/// command takes (name the card or the project in the sentence). And once it
/// did, "tell the auth card to write a pendulum simulation" came back
/// *"Sending this to the auth card"* — a promise nothing on this path can
/// keep, since the voice is one question and one answer with no memory of the
/// next sentence. Hence the explicit "never say you have done those things or
/// that you will". **A voice that claims an act is worse than one that refuses
/// it**, because the person waits for a reply that is never coming.
const VOICE: &str = "You are Volery's voice on the user's phone. Volery puts every \
    running Claude Code conversation on one wall, and each conversation is a card. This \
    phone is a node on that wall: it shows the cards, reads aloud whatever is waiting on the \
    user, hands their answer in their own words back to the card that asked, and answers \
    ordinary questions on its own. Hands-free and the spoken guide live in settings, where \
    the row how to use volery replays the introduction. You cannot run programs, open apps, \
    or change anything on the user's computers; work like that has to be asked of a card on \
    the wall, as one spoken command that names the card or the project, like tell the auth \
    card to write it. Your only power is to answer in words: you cannot open a card, start \
    work or pass a request along, so never say you have done those things or that you will. \
    Answer in one to three short sentences of plain spoken prose, with no markdown, no lists, \
    no headings, no code and no em dashes. If you are asked something about Volery that is \
    not covered here, say plainly that you are not sure rather than inventing an answer.";

/// The DeepSeek key this wall would spend, or a sentence naming what to do
/// about it.
///
/// Two callers ask the same question for different reasons: `answer_question`
/// needs the key, and `assistant::said` needs to know **before it opens a front
/// desk** whether one could ever answer. Without that second ask, a wall with
/// no key answers the phone `talk`, the card fails to open where nobody is
/// looking, and the phone says nothing at all — the one failure on this path
/// that is silent rather than spoken.
pub fn deepseek_key() -> Result<String, String> {
    let p = named("deepseek").ok_or("deepseek is not a provider this build knows")?;
    crate::creds::token(p.key)
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
        .ok_or_else(|| {
            format!(
                "no {} API key is stored, so this wall cannot answer general questions — add one \
                 in the keyring (space then o)",
                p.name
            )
        })
}

/// A one-shot spoken answer from DeepSeek, for a sentence the steward could
/// not place as a Volery command.
///
/// **This is the fallback now.** A wall with a project hands such a sentence to
/// its front desk card instead (`assistant::said`), which can ask a follow-up
/// and open a conversation. What is left here is the wall that has no project
/// to put a front desk in, and which would otherwise have nothing to say at all.
///
/// **Why the wall and not the phone.** The key is in this machine's vault
/// (`creds.rs`), read at the moment of asking and never handed to another
/// device; a phone that held its own copy would be a second secret to keep
/// current and a second balance to watch. The phone asks over the steward wire
/// (`steward::StewardMsg::General`), and this is what the wall runs.
///
/// **`deepseek-flash`, thinking on at low effort.** `deepseek-flash` is the
/// everyday model; `output_config.effort` is DeepSeek's own depth control, and
/// `thinking.budget_tokens` is documented but ignored, so low effort is the
/// only honest "think a little" here. Read from DeepSeek's Anthropic-compatible
/// API documentation, 2026-11-11.
///
/// The answer is capped because it is spoken aloud: a paragraph read by a phone
/// is a minute of somebody's walk. It is scrubbed like every other text that
/// reaches a card or a phone (`crate::clean`).
pub fn answer_question(text: &str) -> Result<String, String> {
    const MODEL: &str = "deepseek-flash";
    const URL: &str = "https://api.deepseek.com/anthropic/v1/messages";
    /// The most a spoken answer may be. A minute of speech is already long for
    /// a walk; past this the phone is reading a page.
    const ANSWER_MOST: usize = 1_200;

    let key = deepseek_key()?;
    let p = named("deepseek").ok_or("deepseek is not a provider this build knows")?;
    let body = serde_json::json!({
        "model": MODEL,
        "max_tokens": 600,
        "thinking": { "type": "enabled" },
        "output_config": { "effort": "low" },
        "system": VOICE,
        "messages": [{ "role": "user", "content": [{ "type": "text", "text": text }] }],
        "stream": false,
    });
    let res = crate::forge::agent()
        .post(URL)
        .set("x-api-key", &key)
        .set("content-type", "application/json")
        .send_string(&body.to_string());
    match res {
        Ok(res) => {
            let v: serde_json::Value = res
                .into_json()
                .map_err(|e| format!("unreadable answer from {}: {e}", p.name))?;
            let mut said = spoken(&v)
                .ok_or_else(|| format!("{} answered with no words", p.name))?;
            if said.chars().count() > ANSWER_MOST {
                said = said.chars().take(ANSWER_MOST - 1).collect::<String>() + "…";
            }
            Ok(said)
        }
        Err(ureq::Error::Status(code, res)) => Err(format!(
            "{} answered {code}{}",
            p.name,
            crate::creds::trailing_anthropic(res.into_string().unwrap_or_default())
        )),
        Err(e) => Err(format!("could not reach {}: {e}", p.name)),
    }
}

/// The words out of a Messages answer: every `text` block, in order, scrubbed.
/// Thinking blocks and tool blocks are not speech and are skipped. `None` when
/// there is no text at all, which is a refusal or a truncated thinking-only
/// turn and not something to read aloud.
fn spoken(v: &serde_json::Value) -> Option<String> {
    let blocks = v.get("content")?.as_array()?;
    let mut parts = Vec::new();
    for b in blocks {
        if b.get("type").and_then(|t| t.as_str()) != Some("text") {
            continue;
        }
        if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
            let clean = crate::clean::scrub(t).trim().to_string();
            if !clean.is_empty() {
                parts.push(clean);
            }
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

/// The balance as one sentence, for the `allowance` tool. Network failure is
/// said rather than hidden: a card asking what it can afford is owed the
/// reason it was not told.
pub fn balance_said(p: &'static Provider) -> String {
    match fetch_balance(p) {
        Ok(b) => format!(
            "Balance: {} {:.2} left ({} granted, {} topped up).",
            b.currency, b.total, b.granted, b.topped_up
        ),
        Err(e) => format!("The balance could not be read: {e}."),
    }
}

/// What the keyring draws. Network failure is carried, not raised: the local
/// spend and the cap are still worth showing when the balance is not.
#[tauri::command]
pub async fn provider_reading(app: AppHandle, provider: String) -> Result<Reading, String> {
    let p = named(&provider).ok_or_else(|| format!("there is no provider called {provider:?}"))?;
    let (spent, limit, from) = {
        let store = app
            .try_state::<crate::store::Store>()
            .ok_or_else(|| "the store is unavailable".to_string())?;
        let conn = store.0.lock().map_err(|_| "the store is unavailable".to_string())?;
        let b = crate::store::provider_budget(&conn, p.key);
        let spent = crate::store::provider_spent(&conn, p.label, b.from_at);
        (spent, b.limit, b.from_at)
    };
    let fetched = crate::off_main(move || fetch_balance(p))
        .await
        .unwrap_or_else(|e| Err(e));
    let (balance, fault) = match fetched {
        Ok(b) => (Some(b), None),
        Err(e) => (None, Some(e)),
    };
    Ok(Reading {
        provider: p.key.to_string(),
        spent,
        limit,
        from,
        balance,
        fault,
    })
}

/// Set the wall's cap for a provider. `usd = 0` clears it.
#[tauri::command]
pub fn set_provider_limit(
    store: State<'_, crate::store::Store>,
    provider: String,
    usd: f64,
) -> Result<(), String> {
    let p = named(&provider).ok_or_else(|| format!("there is no provider called {provider:?}"))?;
    let conn = store.0.lock().map_err(|_| "the store is unavailable")?;
    crate::store::set_provider_budget(&conn, p.key, usd, crate::store::now())?;
    Ok(())
}

/// Why a prompt into this card must not be sent, or none.
///
/// Called from `deliver_blocks` — the one door every prompt goes through,
/// whether typed, spawned, woken by a subscription or written by a relay — so
/// the cap cannot be bypassed by a path that forgot to ask. A provider card
/// whose limit is reached is refused before the write, with the number in the
/// sentence; the local spend is the wall's own `turn.usd`, which for a provider
/// is priced from `usage.ts` because the CLI has no row for a model it did not
/// make.
pub fn budget_refusal(app: &AppHandle, card: &str) -> Option<String> {
    let store = app.try_state::<crate::store::Store>()?;
    let conn = store.0.lock().ok()?;
    let label = crate::store::account_of(&conn, card)?;
    let p = of(Some(&label))?;
    let b = crate::store::provider_budget(&conn, p.key);
    if b.limit <= 0.0 {
        return None;
    }
    let spent = crate::store::provider_spent(&conn, p.label, b.from_at);
    if spent < b.limit {
        return None;
    }
    Some(format!(
        "{}'s spending limit is reached — ${spent:.2} spent of ${:.2}. Raise it in the keyring \
         (space then o), or open the card on another provider. Nothing was sent.",
        p.name, b.limit
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An answer is its text blocks, scrubbed, and never the thinking that
    /// preceded them: a phone reads the words, not the reasoning, and an
    /// impossible character must not ride into a spoken line.
    #[test]
    fn an_answer_is_its_text_blocks_and_never_its_thinking() {
        let v = serde_json::json!({ "content": [
            { "type": "thinking", "thinking": "the user wants the weather" },
            { "type": "text", "text": "it is raining\u{0} in paris" },
            { "type": "tool_use", "name": "x" },
            { "type": "text", "text": " bring a coat" },
        ] });
        assert_eq!(spoken(&v).as_deref(), Some("it is raining in paris\nbring a coat"));
        assert!(spoken(&serde_json::json!({ "content": [{ "type": "thinking", "thinking": "x" }] })).is_none());
        assert!(spoken(&serde_json::json!({})).is_none());
    }

    /// The facts without which the voice describes a generic assistant
    /// instead of this app (which it did on 2026-11-11), and the line that
    /// stops it claiming an act it cannot perform (which it did the same day,
    /// in answer to "tell the auth card to write a pendulum simulation").
    /// Held against a rewrite of the prose rather than the prose itself,
    /// since the wording is not what makes any of it true.
    #[test]
    fn the_voice_is_told_what_it_is_speaking_for() {
        for fact in [
            "Volery",
            "card",
            "cannot run programs",
            "never say you have done those things",
        ] {
            assert!(VOICE.contains(fact), "the voice's prompt lost {fact:?}");
        }
    }

    #[test]
    fn a_provider_label_is_found_and_an_account_is_not() {
        assert_eq!(of(Some(DEEPSEEK)).map(|p| p.name), Some("deepseek"));
        assert_eq!(of(Some(" @deepseek ")).map(|p| p.name), Some("deepseek"));
        assert!(of(Some("@credits")).is_none());
        assert!(of(Some("claude")).is_none());
        assert!(of(None).is_none());
    }

    /// The wire model is a Claude alias the CLI recognises, and the provider's
    /// own names map onto the two families. A provider name reaching `--model`
    /// is the bug the first live card found (`[claude-code:unrecognized_model]`).
    #[test]
    fn every_provider_speaks_a_model_the_cli_knows() {
        for p in PROVIDERS {
            assert_eq!(p.base_url, "https://api.deepseek.com/anthropic");
            assert_eq!(p.key, "deepseek");
            assert_eq!(p.model, "sonnet");
        }
        let p = &PROVIDERS[0];
        assert_eq!(cli_model(p, Some("deepseek-v4-pro")), "opus");
        assert_eq!(cli_model(p, Some("deepseek-flash")), "sonnet");
        assert_eq!(cli_model(p, Some("opus[1m]")), "opus");
        assert_eq!(cli_model(p, Some("claude-sonnet-5")), "sonnet");
        assert_eq!(cli_model(p, None), "sonnet");
    }
}
