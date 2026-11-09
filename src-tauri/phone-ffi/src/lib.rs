//! The JNI bridge between the phone app (Kotlin) and the phone node.
//!
//! `docs/PHONE.md` M2b. The node's whole surface is three async calls —
//! `Node::start(key, name)`, `Node::sight(host)` and
//! `Node::fetch(host, card, want)` — and this crate is the cdylib the Android
//! app links. It holds one node in a process-wide slot,
//! drives the async calls on a held tokio runtime, and crosses the JNI
//! boundary as a JSON envelope: `{"ok": …}` on success, `{"err": "…"}` on
//! failure, which the Kotlin side parses with `org.json`.
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
//! shaped as three calls, not a handle factory.
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
use phone_node::Node;
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

/// `sight(host)` → `{"ok": {"roster": […], "cards": {…}}}` or `{"err": …}`.
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
    json!({ "roster": roster, "cards": cards })
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
            roster: vec![heard("phone"), heard("lab-m2.queerisfreedom")],
            cards: Some(Digest {
                host: "lab-m2.queerisfreedom".into(),
                version: 7,
                age_ms: 5,
                snapshot: json!({ "v": 1 }),
            }),
        };
        let v = sight_value(s);
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
        let s = Sighting { roster: vec![heard("phone")], cards: None };
        let v = sight_value(s);
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
}
