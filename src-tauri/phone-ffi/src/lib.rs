//! The JNI bridge between the phone app (Kotlin) and the phone node.
//!
//! `docs/PHONE.md` M2b, M3. The node's surface is `Node::start(key, name)` and
//! the one-shot exchanges — `sight`, `sight_any`, `fetch`, `plan`, `confirm`,
//! `answer` — plus one pure fold, `narrate`, which runs
//! `phone_node::diff` over two digests and needs no node and no network. This
//! crate is the cdylib the Android app links. It holds one node in a
//! process-wide slot, drives the async calls on a held tokio runtime, and
//! crosses the JNI boundary as a JSON envelope: `{"ok": …}` on success,
//! `{"err": "…"}` on failure, which the Kotlin side parses with `org.json`.
//!
//! ### Why JNI rather than uniffi
//!
//! The brief's preference was uniffi, and it genuinely fights here rather than
//! merely being unfamiliar. Half of what `sight` returns is a
//! `serde_json::Value` — the cards snapshot, deliberately opaque so a card's
//! taxonomy stays in `classify.ts` (`cards.rs`) — and `start` takes a
//! `WallKey`, which derives nothing on purpose so a secret is never one `{:?}`
//! away from a log line (`seal.rs`). Neither is an uniffi-mappable type, so
//! uniffi would need a hand-written flattening layer *anyway*. Given that the
//! flattening has to exist either way, a JSON envelope over JNI is less
//! machinery than uniffi's proc-macros, bindgen step and async-executor
//! wiring, and `jni` (pure Rust) is the only crate added to the tree.
//!
//! A phone is one node, so a process-wide slot is the honest shape of the
//! thing rather than a workaround — the same reason the node's surface was
//! shaped as a few calls, not a handle factory.
//!
//! ### The one thing Android needs that the desktop never did
//!
//! iroh's `platform-verifier` feature reads the system trust store through the
//! Android `Context`, so a process with no Context panics at the first dial
//! (`ndk-context: android context was not initialized`). The app must call
//! `initPlatformVerifier(context)` once, before `start`, with its application
//! Context. That is `rustls_platform_verifier::android::init_with_env`.

use std::sync::{Arc, Mutex, OnceLock};

use flyway_core::seal::WallKey;
use jni::errors::{LogErrorAndDefault, Result as JniResult};
use jni::objects::{JObject, JString};
use jni::sys::jstring;
use jni::{Env, EnvUnowned};
use phone_node::{Digest, Node};
use serde_json::{json, Value};

#[cfg(target_os = "android")]
use rustls_platform_verifier;

/// The one node this process holds. `Arc` so `sight` can clone it out of the
/// lock and drop the guard before awaiting, since the node is not `Clone`.
static NODE: OnceLock<Mutex<Option<Arc<Node>>>> = OnceLock::new();

/// The runtime every async call is driven on. Held for the process lifetime —
/// iroh's endpoint spawns tasks onto it, so it must outlive the node.
static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();

fn node() -> &'static Mutex<Option<Arc<Node>>> {
    NODE.get_or_init(|| Mutex::new(None))
}

fn rt() -> &'static tokio::runtime::Runtime {
    RT.get_or_init(|| tokio::runtime::Runtime::new().expect("a tokio runtime"))
}

/// `initPlatformVerifier(context)` → `{"ok": true}` or `{"err": …}`.
///
/// Hands the application Context to the platform verifier so a dial can read
/// the Android trust store. Idempotent (`get_or_try_init`), and the Context is
/// stored as a global reference, so the app should pass its long-lived
/// application Context rather than an Activity.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_volery_phone_NativeBridge_initPlatformVerifier<'caller>(
    mut unowned_env: EnvUnowned<'caller>,
    _this: JObject<'caller>,
    context: JObject<'caller>,
) -> jstring {
    unowned_env
        .with_env(|env| {
            let result = rustls_platform_verifier::android::init_with_env(env, context)
                .map(|_| json!({ "ok": true }))
                .map_err(|e| format!("platform verifier init failed: {e}"));
            to_jstring(env, result)
        })
        .resolve::<LogErrorAndDefault>()
}

/// `start(key_phrase, name)` → `{"ok": {"name": name}}` or `{"err": …}`.
///
/// The key is the phrase a person carries between machines (`WallKey::phrase`),
/// not the 32 raw bytes — that is what the vault stores and what a person would
/// type, so it is the only form the app ever holds.
#[no_mangle]
pub extern "system" fn Java_com_volery_phone_NativeBridge_start<'caller>(
    mut unowned_env: EnvUnowned<'caller>,
    _this: JObject<'caller>,
    phrase: JString<'caller>,
    name: JString<'caller>,
) -> jstring {
    unowned_env
        .with_env(|env| {
            let phrase = read(env, &phrase);
            let name = read(env, &name);
            to_jstring(env, start(&phrase, &name))
        })
        .resolve::<LogErrorAndDefault>()
}

/// `sight(host)` → `{"ok": {"host": …, "roster": […], "cards": {…}}}` or
/// `{"err": …}`.
#[no_mangle]
pub extern "system" fn Java_com_volery_phone_NativeBridge_sight<'caller>(
    mut unowned_env: EnvUnowned<'caller>,
    _this: JObject<'caller>,
    host: JString<'caller>,
) -> jstring {
    unowned_env
        .with_env(|env| {
            let host = read(env, &host);
            to_jstring(env, sight(&host))
        })
        .resolve::<LogErrorAndDefault>()
}

/// `sightAny(host, remembered)` → the same envelope as `sight`, whose `host`
/// is whichever wall answered. `remembered` is a JSON array of wall names the
/// phone last saw. The walk is `Node::sight_any`: the chosen wall, then those
/// names, then the flyway's directory, so a phone whose laptop is off still
/// finds the flyway on another one.
#[no_mangle]
pub extern "system" fn Java_com_volery_phone_NativeBridge_sightAny<'caller>(
    mut unowned_env: EnvUnowned<'caller>,
    _this: JObject<'caller>,
    host: JString<'caller>,
    remembered: JString<'caller>,
) -> jstring {
    unowned_env
        .with_env(|env| {
            let host = read(env, &host);
            let remembered = read(env, &remembered);
            to_jstring(env, sight_any(&host, &remembered))
        })
        .resolve::<LogErrorAndDefault>()
}

/// `fetch(host, card, kind, kept, path)` → `{"ok": {"name": …, "data": …,
/// "bytes": …, "size": …, "tooLarge": …, "full": …}}` or `{"err": …}`.
///
/// `kind` is `"picture"` or `"file"`. A picture takes `kept` (a `show` copy's
/// name) or `path`, whichever is non-empty; a file takes `path`. The `card` id
/// is the one the phone read out of the digest, passed back so the far wall
/// can gate the read and count a relative path from where that card runs.
#[no_mangle]
pub extern "system" fn Java_com_volery_phone_NativeBridge_fetch<'caller>(
    mut unowned_env: EnvUnowned<'caller>,
    _this: JObject<'caller>,
    host: JString<'caller>,
    card: JString<'caller>,
    kind: JString<'caller>,
    kept: JString<'caller>,
    path: JString<'caller>,
) -> jstring {
    unowned_env
        .with_env(|env| {
            let host = read(env, &host);
            let card = read(env, &card);
            let kind = read(env, &kind);
            let kept = read(env, &kept);
            let path = read(env, &path);
            to_jstring(env, fetch(&host, &card, &kind, &kept, &path))
        })
        .resolve::<LogErrorAndDefault>()
}

/// `narrate(prev, curr, chatty)` → `{"ok": {"lines": [{"kind": …, "card": …,
/// "text": …}], "needsYou": bool}}` or `{"err": …}`.
///
/// The pure fold (`phone_node::diff`) over two digests, so it needs no node and
/// no network: `prev` and `curr` are the JSON of a digest — the `cards` object
/// `sight` already returns — and `prev` may be `""` for a first sighting, which
/// folds to silence (no baseline). `chatty` is `"off"`, `"needs"` or
/// `"murmur"`. `needsYou` is computed from the change alone, at every level,
/// so the app can duck music without also asking for a murmur.
#[no_mangle]
pub extern "system" fn Java_com_volery_phone_NativeBridge_narrate<'caller>(
    mut unowned_env: EnvUnowned<'caller>,
    _this: JObject<'caller>,
    prev: JString<'caller>,
    curr: JString<'caller>,
    chatty: JString<'caller>,
) -> jstring {
    unowned_env
        .with_env(|env| {
            let prev = read(env, &prev);
            let curr = read(env, &curr);
            let chatty = read(env, &chatty);
            to_jstring(env, narrate(&prev, &curr, &chatty))
        })
        .resolve::<LogErrorAndDefault>()
}

/// `steward(host, transcript)` → `{"ok": {"id": …, "answer": {…}}}` or
/// `{"err": …}`.
///
/// Hands a spoken transcript to a wall to be turned into a plan, and returns
/// the plan's id and the whole of what the wall's steward decided — most often
/// `{ "kind": "plan", "plan": { "reads": …, "needs": … } }`. The id is what
/// `confirm` names, so the app never holds or sends the steps back.
#[no_mangle]
pub extern "system" fn Java_com_volery_phone_NativeBridge_steward<'caller>(
    mut unowned_env: EnvUnowned<'caller>,
    _this: JObject<'caller>,
    host: JString<'caller>,
    transcript: JString<'caller>,
) -> jstring {
    unowned_env
        .with_env(|env| {
            let host = read(env, &host);
            let transcript = read(env, &transcript);
            to_jstring(env, steward(&host, &transcript))
        })
        .resolve::<LogErrorAndDefault>()
}

/// `confirm(host, id)` → `{"ok": {…}}` or `{"err": …}`.
///
/// Confirms the plan the wall returned for `id` — the id `steward` handed
/// back — and has the wall carry it out. The answer is the carry's outcome,
/// `{ "kind": "done" | "refused" | "stopped", … }`, which the app narrates
/// (a failure carries `why`; a success says nothing, since the digest delta
/// then says what opened).
#[no_mangle]
pub extern "system" fn Java_com_volery_phone_NativeBridge_confirm<'caller>(
    mut unowned_env: EnvUnowned<'caller>,
    _this: JObject<'caller>,
    host: JString<'caller>,
    id: JString<'caller>,
) -> jstring {
    unowned_env
        .with_env(|env| {
            let host = read(env, &host);
            let id = read(env, &id);
            to_jstring(env, confirm(&host, &id))
        })
        .resolve::<LogErrorAndDefault>()
}

/// `answer(host, card, askId, text)` → `{"ok": true}` or `{"err": …}`.
///
/// Answers a question a card on the wall has parked on `ask_user`. Fire-and-
/// forget: the wall hands the text to the parked call through its own answer
/// path, and the result surfaces in the wall's next digest (the question gone,
/// the card resumed). A refusal reads the same way there.
#[no_mangle]
pub extern "system" fn Java_com_volery_phone_NativeBridge_answer<'caller>(
    mut unowned_env: EnvUnowned<'caller>,
    _this: JObject<'caller>,
    host: JString<'caller>,
    card: JString<'caller>,
    ask_id: JString<'caller>,
    text: JString<'caller>,
) -> jstring {
    unowned_env
        .with_env(|env| {
            let host = read(env, &host);
            let card = read(env, &card);
            let ask_id = read(env, &ask_id);
            let text = read(env, &text);
            to_jstring(env, answer(&host, &card, &ask_id, &text))
        })
        .resolve::<LogErrorAndDefault>()
}

/// `prompts(cards)` → `{"ok": {"prompts": […]}}` or `{"err": …}`.
///
/// Everything a wall is waiting on a person for, read off the `cards` envelope
/// `sight` returns: parked and filed questions, removal and close
/// confirmations, every other confirmation, and the notice queue. Pure, so it
/// needs no node and no network — the app calls it whenever a sighting lands.
#[no_mangle]
pub extern "system" fn Java_com_volery_phone_NativeBridge_prompts<'caller>(
    mut unowned_env: EnvUnowned<'caller>,
    _this: JObject<'caller>,
    cards: JString<'caller>,
) -> jstring {
    unowned_env
        .with_env(|env| {
            let cards = read(env, &cards);
            to_jstring(env, prompts(&cards))
        })
        .resolve::<LogErrorAndDefault>()
}

/// `tail(host, card)` → `{"ok": {"lines": [{"you": bool, "text": …}]}}` or
/// `{"err": …}`.
///
/// The prose that led to a card's prompt: its conversation read on demand,
/// reduced to the agent's and the person's own words. Tool calls, tool results,
/// compaction summaries and skills never cross — a phone wants the paragraph,
/// not a transcript.
#[no_mangle]
pub extern "system" fn Java_com_volery_phone_NativeBridge_tail<'caller>(
    mut unowned_env: EnvUnowned<'caller>,
    _this: JObject<'caller>,
    host: JString<'caller>,
    card: JString<'caller>,
) -> jstring {
    unowned_env
        .with_env(|env| {
            let host = read(env, &host);
            let card = read(env, &card);
            to_jstring(env, tail(&host, &card))
        })
        .resolve::<LogErrorAndDefault>()
}

/// `composeAnswers(headers, picks)` → `{"ok": {"text": …}}` or `{"err": …}`.
///
/// The reply a sheet of picks composes, in the exact shape the agent reads:
/// one question is the bare answer, several are a numbered list carrying each
/// question's header, and an unanswered slot is `skipped`. Both arguments are
/// JSON arrays of strings; the shape is `asking.ts::composeAnswer`'s and must
/// not drift, which is why the phone asks this crate rather than composing in
/// Kotlin.
#[no_mangle]
pub extern "system" fn Java_com_volery_phone_NativeBridge_composeAnswers<'caller>(
    mut unowned_env: EnvUnowned<'caller>,
    _this: JObject<'caller>,
    headers: JString<'caller>,
    picks: JString<'caller>,
) -> jstring {
    unowned_env
        .with_env(|env| {
            let headers = read(env, &headers);
            let picks = read(env, &picks);
            to_jstring(env, compose_answers(&headers, &picks))
        })
        .resolve::<LogErrorAndDefault>()
}

fn read(env: &Env<'_>, s: &JString<'_>) -> String {
    s.try_to_string(env).unwrap_or_default()
}

fn start(phrase: &str, name: &str) -> Result<Value, String> {
    let key = WallKey::from_phrase(phrase)?;
    let n = rt().block_on(Node::start(key, name.to_string()))?;
    *node().lock().unwrap() = Some(Arc::new(n));
    Ok(json!({ "name": name }))
}

fn sight(host: &str) -> Result<Value, String> {
    let held = node().lock().unwrap().clone().ok_or("not started — call start first")?;
    let s = rt().block_on(held.sight(host))?;
    Ok(sight_value(s))
}

/// The remembered list crosses as JSON, so a wall called `a,b` is one name and
/// a malformed list is refused by name rather than silently read as empty.
fn sight_any(host: &str, remembered: &str) -> Result<Value, String> {
    let remembered = remembered_list(remembered)?;
    let held = node().lock().unwrap().clone().ok_or("not started — call start first")?;
    let s = rt().block_on(held.sight_any(host, &remembered))?;
    Ok(sight_value(s))
}

fn remembered_list(json: &str) -> Result<Vec<String>, String> {
    if json.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(json).map_err(|e| format!("unreadable wall list: {e}"))
}

fn fetch(host: &str, card: &str, kind: &str, kept: &str, path: &str) -> Result<Value, String> {
    let held = node().lock().unwrap().clone().ok_or("not started — call start first")?;
    let want = match kind {
        "picture" => phone_node::Media::Picture {
            kept: if kept.is_empty() { None } else { Some(kept.to_string()) },
            path: if path.is_empty() { None } else { Some(path.to_string()) },
        },
        "file" => phone_node::Media::File { path: path.to_string() },
        other => return Err(format!("fetch wants \"picture\" or \"file\", not \"{other}\"")),
    };
    let f = rt().block_on(held.fetch(host, card, want))?;
    Ok(fetch_value(f))
}

fn steward(host: &str, transcript: &str) -> Result<Value, String> {
    let held = node().lock().unwrap().clone().ok_or("not started — call start first")?;
    let (id, answer) = rt().block_on(held.plan(host, transcript))?;
    Ok(json!({ "id": id, "answer": answer }))
}

fn confirm(host: &str, id: &str) -> Result<Value, String> {
    let held = node().lock().unwrap().clone().ok_or("not started — call start first")?;
    rt().block_on(held.confirm(host, id))
}

fn answer(host: &str, card: &str, ask_id: &str, text: &str) -> Result<Value, String> {
    let held = node().lock().unwrap().clone().ok_or("not started — call start first")?;
    rt().block_on(held.answer(host, card, ask_id, text))?;
    Ok(json!(true))
}

fn prompts(cards: &str) -> Result<Value, String> {
    let v: Value = serde_json::from_str(cards).map_err(|e| format!("unreadable digest: {e}"))?;
    let snapshot = v.get("snapshot").cloned().unwrap_or(Value::Null);
    let age = v.get("age_ms").and_then(Value::as_u64).unwrap_or(0);
    /* The wall that published this, carried on every row: an answer must be
       dialled to the wall that holds the card, and `Config.host` is only the
       wall the screen happens to be drawing — a chip tap or a background walk
       can move it between the draw and the tap. */
    let host = v.get("host").and_then(Value::as_str).unwrap_or_default();
    let rows = phone_node::prompts_of(&snapshot, age);
    Ok(json!({
        "prompts": rows.iter().map(|p| prompt_value(p, host)).collect::<Vec<_>>(),
    }))
}

fn tail(host: &str, card: &str) -> Result<Value, String> {
    let held = node().lock().unwrap().clone().ok_or("not started — call start first")?;
    let said = rt().block_on(held.tail(host, card))?;
    Ok(json!({
        "lines": said
            .iter()
            .map(|s| json!({ "you": s.you, "text": s.text }))
            .collect::<Vec<_>>(),
    }))
}

fn compose_answers(headers: &str, picks: &str) -> Result<Value, String> {
    let headers: Vec<String> = serde_json::from_str(headers).map_err(|e| format!("unreadable questions: {e}"))?;
    let picks: Vec<String> = serde_json::from_str(picks).map_err(|e| format!("unreadable answers: {e}"))?;
    if headers.is_empty() {
        return Err("there was no question to answer".into());
    }
    let questions: Vec<phone_node::Question> = headers
        .into_iter()
        .map(|header| phone_node::Question { header, body: String::new(), options: Vec::new(), shows: false })
        .collect();
    Ok(json!({ "text": phone_node::compose(&questions, &picks) }))
}

/// One prompt in the shape the app draws: the card it belongs to, the exact
/// `answers` value an answer names, and its questions. `blocking` and
/// `startsWork` are decisions the screen makes before a tap, so they are said
/// here rather than re-derived in Kotlin.
fn prompt_value(p: &phone_node::Prompt, host: &str) -> Value {
    json!({
        "host": host,
        "card": p.card,
        "title": p.title,
        "kind": p.kind.word(),
        "answers": p.answers,
        "waitedMs": p.waited_ms,
        "blocking": p.kind != phone_node::prompts::Kind::Notice,
        "startsWork": p.kind.starts_work(),
        "ack": p.ack,
        "questions": p
            .questions
            .iter()
            .map(|q| json!({
                "header": q.header,
                "body": q.body,
                "shows": q.shows,
                "options": q
                    .options
                    .iter()
                    .map(|o| json!({ "label": o.label, "detail": o.detail }))
                    .collect::<Vec<_>>(),
            }))
            .collect::<Vec<_>>(),
    })
}

/// Flatten a `Fetched` into the JSON the Kotlin side reads: the bytes stay
/// base64 either way, a file's `size` is null where a picture's is its pixel
/// box, and a picture's `full` is always empty.
fn fetch_value(f: phone_node::Fetched) -> Value {
    json!({
        "name": f.name,
        "data": f.data,
        "bytes": f.bytes,
        "size": f.size,
        "tooLarge": f.too_large,
        "full": f.full,
    })
}

/// Flatten a `Sighting` into the JSON the Kotlin side reads. The roster is
/// trimmed to what a phone screen draws — the host, load and build — and the
/// snapshot is passed through whole, still opaque, because its shape is the
/// wall's front end's to decide and the phone must not grow a second taxonomy.
/// `host` is the wall that answered, which after a walk may not be the one
/// asked; every later call has to address it.
fn sight_value(s: phone_node::Sighting) -> Value {
    let roster: Vec<Value> = s
        .roster
        .iter()
        .map(|h| {
            json!({
                "host": h.wall.host,
                "version": h.wall.version,
                "cards_live": h.wall.facts.cards_live,
                "cards_working": h.wall.facts.cards_working,
                "accepting": h.wall.facts.accepting,
                "build": h.wall.facts.build,
                "age_ms": h.age_ms,
            })
        })
        .collect();
    let cards = s.cards.map(|d| {
        json!({
            "host": d.host,
            "version": d.version,
            "age_ms": d.age_ms,
            "snapshot": d.snapshot,
        })
    });
    json!({ "host": s.host, "roster": roster, "cards": cards })
}

/// The pure fold behind `narrate`: parse the two digests and a chatty level,
/// run the brain's `diff`, and flatten its `Narration` into the envelope. `prev`
/// is empty for a first sighting, which the brain folds to silence.
fn narrate(prev_json: &str, curr_json: &str, chatty: &str) -> Result<Value, String> {
    let chatty = parse_chatty(chatty)?;
    let prev = if prev_json.trim().is_empty() {
        None
    } else {
        Some(parse_digest(prev_json)?)
    };
    let curr = parse_digest(curr_json)?;
    let n = phone_node::diff(prev.as_ref(), &curr, chatty);
    Ok(narration_value(n))
}

fn parse_chatty(s: &str) -> Result<phone_node::Chatty, String> {
    match s {
        "off" => Ok(phone_node::Chatty::Off),
        "needs" => Ok(phone_node::Chatty::Needs),
        "murmur" => Ok(phone_node::Chatty::Murmur),
        other => Err(format!("chatty wants \"off\", \"needs\" or \"murmur\", not \"{other}\"")),
    }
}

/// A digest out of the `cards` JSON `sight` returns. Lenient in the same way the
/// brain's own snapshot reader is: a missing field reads as the value that
/// claims least, and a missing snapshot is `null` (which the fold reads as no
/// cards, not a crash).
fn parse_digest(json: &str) -> Result<Digest, String> {
    let v: Value = serde_json::from_str(json).map_err(|e| format!("unreadable digest: {e}"))?;
    let host = v.get("host").and_then(Value::as_str).unwrap_or_default().to_string();
    let version = v.get("version").and_then(Value::as_u64).unwrap_or(0);
    let age_ms = v.get("age_ms").and_then(Value::as_u64).unwrap_or(0);
    let snapshot = v.get("snapshot").cloned().unwrap_or(Value::Null);
    Ok(Digest { host, version, age_ms, snapshot })
}

/// Flatten a `Narration` into the JSON the Kotlin side reads: each line keeps
/// its `kind` (the brain's stable vocabulary, as a lowercase word), its `card`
/// id, and the sentence, and `needsYou` rides alongside.
fn narration_value(n: phone_node::Narration) -> Value {
    json!({
        "lines": n
            .lines
            .into_iter()
            .map(|l| json!({
                "kind": kind_name(l.kind),
                "card": l.card,
                "text": l.text,
                "askId": l.ask_id,
            }))
            .collect::<Vec<_>>(),
        "needsYou": n.needs_you,
    })
}

fn kind_name(k: phone_node::Kind) -> &'static str {
    match k {
        phone_node::Kind::Opened => "opened",
        phone_node::Kind::Ask => "ask",
        phone_node::Kind::Finished => "finished",
        phone_node::Kind::Started => "started",
        phone_node::Kind::Dormant => "dormant",
        phone_node::Kind::Notice => "notice",
    }
}

fn to_jstring(env: &mut Env<'_>, result: Result<Value, String>) -> JniResult<jstring> {
    let body = match result {
        Ok(v) => json!({ "ok": v }),
        Err(e) => json!({ "err": e }),
    };
    Ok(env.new_string(body.to_string())?.into_raw())
}

#[cfg(test)]
mod tests {
    use super::*;
    use flyway_core::fleet::{Announcement, Facts, Heard};
    use phone_node::{Digest, Fetched, Sighting};

    fn heard(host: &str) -> Heard {
        Heard {
            wall: Announcement {
                host: host.into(),
                version: 1,
                said_at: Some(1),
                facts: Facts::default(),
            },
            age_ms: 0,
        }
    }

    /// The envelope the Kotlin side parses: the roster folds one entry per host
    /// (the phone's own among them, since the wall echoes its announcement
    /// back), and the cards digest rides alongside as its opaque snapshot.
    #[test]
    fn a_sighting_folds_into_the_shape_the_app_reads() {
        let s = Sighting {
            host: "lab-m2.queerisfreedom".into(),
            roster: vec![heard("phone"), heard("lab-m2.queerisfreedom")],
            cards: Some(Digest {
                host: "lab-m2.queerisfreedom".into(),
                version: 7,
                age_ms: 5,
                snapshot: json!({ "v": 1 }),
            }),
        };
        let v = sight_value(s);
        assert_eq!(v["host"], "lab-m2.queerisfreedom", "the answer says which wall opened");
        assert_eq!(v["roster"].as_array().unwrap().len(), 2);
        assert_eq!(v["roster"][0]["host"], "phone");
        assert_eq!(v["cards"]["host"], "lab-m2.queerisfreedom");
        assert_eq!(v["cards"]["snapshot"]["v"], 1);
    }

    /// An absent digest is `cards: null`, not an empty object — the wall said
    /// nothing yet, and the app must draw that as "no cards yet" rather than
    /// "no cards".
    #[test]
    fn no_cards_frame_is_null_in_the_envelope() {
        let s = Sighting { host: "desk".into(), roster: vec![heard("phone")], cards: None };
        let v = sight_value(s);
        assert_eq!(v["host"], "desk");
        assert!(v["cards"].is_null());
    }

    /// The fetch envelope flattens a picture and a file the same way: base64
    /// either way, a picture's `size` is its pixel box, a file's is null, and a
    /// picture's `full` is empty where a file's names its owning wall.
    #[test]
    fn a_fetch_folds_into_the_shape_the_app_reads() {
        let pic = fetch_value(Fetched {
            name: "shot.png".into(),
            data: "iVBOR".into(),
            bytes: 6,
            size: Some((2, 3)),
            too_large: false,
            full: String::new(),
        });
        assert_eq!(pic["name"], "shot.png");
        assert_eq!(pic["size"][0], 2);
        assert_eq!(pic["full"], "");
        let file = fetch_value(Fetched {
            name: "note.md".into(),
            data: "bm90ZQ==".into(),
            bytes: 4,
            size: None,
            too_large: false,
            full: "C:/p/note.md".into(),
        });
        assert_eq!(file["bytes"], 4);
        assert!(file["size"].is_null());
        assert_eq!(file["full"], "C:/p/note.md");
    }

    /// A `cards` envelope for `narrate`, over the given snapshot cards.
    fn cards(version: u64, snapshot_cards: Value) -> String {
        json!({
            "host": "desk",
            "version": version,
            "age_ms": 0,
            "snapshot": json!({ "v": 1, "at": version, "cards": snapshot_cards }),
        })
        .to_string()
    }

    fn busy_card() -> Value {
        json!({ "id": "a", "title": "auth work", "working": true, "dormant": false })
    }

    fn done_card() -> Value {
        json!({ "id": "a", "title": "auth work", "working": false, "dormant": false, "ending": "ok" })
    }

    /// `narrate` folds a `working → idle` move into one `finished` line at
    /// `murmur`, with the sentence, card id and the `needsYou` flag that a
    /// plain finish does not raise.
    #[test]
    fn narrate_folds_a_finish_into_one_line_at_murmur() {
        let v = narrate(&cards(1, json!([busy_card()])), &cards(2, json!([done_card()])), "murmur").unwrap();
        let lines = v["lines"].as_array().unwrap();
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["kind"], "finished");
        assert_eq!(lines[0]["text"], "auth work finished.");
        assert_eq!(lines[0]["card"], "a");
        assert_eq!(v["needsYou"], false);
    }

    /// The same finish at `needs` is not something that needs her, so the
    /// envelope is empty and the flag is clear.
    #[test]
    fn needs_says_nothing_for_a_plain_finish() {
        let v = narrate(&cards(1, json!([busy_card()])), &cards(2, json!([done_card()])), "needs").unwrap();
        assert!(v["lines"].as_array().unwrap().is_empty());
        assert_eq!(v["needsYou"], false);
    }

    /// A question is said at `needs` and raises the flag whatever the level.
    #[test]
    fn a_question_is_said_at_needs_and_raises_the_flag() {
        let prev = cards(1, json!([json!({ "id": "a", "title": "caravan", "working": false, "dormant": false, "ending": "ok" })]));
        let curr = cards(2, json!([json!({ "id": "a", "title": "caravan", "working": false, "dormant": false, "asks": [{}] })]));
        let v = narrate(&prev, &curr, "needs").unwrap();
        let lines = v["lines"].as_array().unwrap();
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["kind"], "ask");
        assert_eq!(v["needsYou"], true);
    }

    /// An empty `prev` is a first sighting — silence, not a fanfare.
    #[test]
    fn no_previous_digest_is_silence() {
        let v = narrate("", &cards(1, json!([busy_card()])), "murmur").unwrap();
        assert!(v["lines"].as_array().unwrap().is_empty());
        assert_eq!(v["needsYou"], false);
    }

    /// An unknown chatty level is refused by name, not silently treated as off.
    #[test]
    fn an_unknown_chatty_level_is_refused() {
        let err = narrate("", &cards(1, json!([])), "loud").unwrap_err();
        assert!(err.contains("chatty"), "the error names what was wrong: {err}");
    }

    /// The walls the app kept cross as a JSON array. Empty is no walls; a
    /// malformed list is refused by name rather than quietly becoming "none",
    /// which would leave a phone walking from one host when it had several.
    #[test]
    fn the_remembered_list_is_json_and_a_bad_one_is_refused() {
        assert_eq!(remembered_list("").unwrap(), Vec::<String>::new());
        assert_eq!(remembered_list("  ").unwrap(), Vec::<String>::new());
        assert_eq!(remembered_list(r#"["a","B"]"#).unwrap(), vec!["a".to_string(), "B".to_string()]);
        let bad = remembered_list("[a,b]").unwrap_err();
        assert!(bad.contains("wall list"), "the error names what was wrong: {bad}");
        assert!(remembered_list(r#"["a",3]"#).is_err(), "a name is a string, not a number");
    }

    /// The prompts envelope the app draws: a parked question, its options, and
    /// the id an answer names, read from the same `cards` object a sighting
    /// leaves in `NodeState`.
    #[test]
    fn prompts_reads_the_cards_object_the_app_holds() {
        let c = cards(
            1,
            json!([{
                "id": "c1", "title": "caravan",
                "asks": [{
                    "askId": "ask-1", "since": 0,
                    "questions": [{
                        "header": "which", "question": "square or circle?",
                        "options": [{ "label": "square", "detail": "the honest one" }, { "label": "circle" }],
                    }],
                }],
            }]),
        );
        let v = prompts(&c).unwrap();
        assert_eq!(v["prompts"][0]["host"], "desk", "the publishing wall rides every row");
        assert_eq!(v["prompts"][0]["card"], "c1");
        assert_eq!(v["prompts"][0]["answers"], "ask-1");
        assert_eq!(v["prompts"][0]["kind"], "question");
        assert_eq!(v["prompts"][0]["blocking"], true);
        assert_eq!(v["prompts"][0]["questions"][0]["body"], "square or circle?");
        assert_eq!(v["prompts"][0]["questions"][0]["options"][0]["detail"], "the honest one");
        assert_eq!(v["prompts"][0]["questions"][0]["options"][1]["detail"], "");
    }

    /// A reply of several is the numbered shape an agent reads, composed here
    /// rather than in Kotlin; an empty question list is refused by name.
    #[test]
    fn a_reply_of_several_is_numbered_by_the_bridge() {
        let v = compose_answers(r#"["which","how many"]"#, r#"["square","three"]"#).unwrap();
        assert_eq!(v["text"], "Answering each in turn:\n1. which: square\n2. how many: three");
        let bare = compose_answers(r#"["which"]"#, r#"["square"]"#).unwrap();
        assert_eq!(bare["text"], "square");
        assert!(compose_answers("[]", "[]").unwrap_err().contains("no question"));
        assert!(compose_answers("[a]", "[]").unwrap_err().contains("unreadable questions"));
    }

    /// A digest with no snapshot reads as `null`, not a crash — the same lenient
    /// read the brain's own snapshot reader keeps.
    #[test]
    fn a_digest_with_no_snapshot_reads_as_null() {
        let d = parse_digest(r#"{"host":"desk"}"#).unwrap();
        assert_eq!(d.host, "desk");
        assert_eq!(d.version, 0);
        assert!(d.snapshot.is_null());
    }
}
