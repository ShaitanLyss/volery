//! The prompt vault: the one place a prompt's words are kept, and only sealed.
//!
//! `docs/ANALYTICS.md` §3.8 and §17. Phase 5a records a prompt's **form** and
//! throws the text away; this is 5b, which keeps a redacted body under a key
//! only a passphrase unwraps. Three properties are the whole design:
//!
//! - **The disk is opaque.** A 32-byte data key is generated once per vault and
//!   sealed with an Argon2id-derived key from the passphrase; every body is
//!   ChaCha20-Poly1305 under that data key with a fresh nonce. A copied SQLite
//!   file, a backup or a peer's disk holds ciphertext and a wrapped key, and
//!   nothing else. The passphrase is never stored, never logged and never in a
//!   fault string.
//! - **A body cannot travel to another row.** Each one is sealed with associated
//!   data naming its `(vault_id, host, session, prompt_id, first_at)`, encoded
//!   length-prefixed so no two rows' fields can be re-split into each other's.
//!   Moving a blob is not a wrong-looking prompt, it is a blob that does not
//!   open.
//! - **The key is memory-only.** It lives in a `Zeroizing<[u8; 32]>` behind a
//!   lock, and goes on `lock`, on quit, and fifteen minutes after the last
//!   gesture that touched it. Sealing an ingested prompt deliberately does
//!   *not* count as a gesture: a wall recording prompts all afternoon is not a
//!   person working, and treating it as one would keep the key in memory for as
//!   long as the app is open.
//!
//! **Redaction is not this module's job and must not become optional.** Sealing
//! makes a stolen file useless; redaction makes a *leaked* copy useless, and
//! §3.8 wants both. `redact::redact` runs on every prompt whether or not a vault
//! exists, `Reading::prompt` hands the redacted text here, and nothing in this
//! file can be reached with a raw one.
//!
//! The threat model, stated with its limit: the vault protects the redacted
//! archive, not the original prompt. That stays in Claude Code's transcript in
//! plaintext on the same machine, and a stolen laptop takes both.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::sync::{Arc, Mutex, Weak};

use argon2::{Algorithm, Argon2, Params, Version};
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, CHACHA20_POLY1305, NONCE_LEN};
use ring::rand::{SecureRandom, SystemRandom};
use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::{AppHandle, Manager};
use zeroize::Zeroizing;

use crate::redact::Redacted;
use crate::store::{self, Store};

/* ── the shapes §3.8 fixes, as constants so they are said once ──────────── */

/// What a kept body is capped at, before it is sealed.
///
/// A body is about a kilobyte and the volume is a few hundred a day, so this is
/// a bound on one pathological paste rather than a budget any real prompt
/// meets. Truncation is a flag on the fact, not a marker in the text: a marker
/// would be read as the person's own words once unsealed.
pub const BODY_CAP: usize = 8 * 1024;

/// A passphrase shorter than this is refused rather than accepted and warned
/// about. The wrapped key is offline-crackable and the record travels to peers,
/// so a weak passphrase is not a private matter.
pub const MIN_PASSPHRASE: usize = 12;

/// Long enough that nobody real meets it, short enough to bound Argon2id's
/// input. A megabyte of passphrase is a denial of service against the unlock.
pub const MAX_PASSPHRASE: usize = 1024;

pub const SALT_LEN: usize = 16;

/// Fifteen minutes idle. §3.8's number, and measured from the last *gesture*
/// rather than the last use — see the module comment.
pub const IDLE_MS: i64 = 15 * 60 * 1000;

/// How often the idle watcher looks at the clock. It costs one mutex take and
/// two comparisons per half minute, and it is what makes the key actually go
/// away while the app sits there rather than only the next time something asks.
const WATCH_MS: u64 = 30_000;

/// How many locators one transaction closes. The same discipline `write_prompts`
/// keeps: a pass that dies mid-way leaves whole chunks committed, and every
/// write here is idempotent against the fact row's state guard.
const SEAL_CHUNK: usize = 50;

/// How many unresolved ids an answer names before it just counts them.
const NAMED_UNRESOLVED: usize = 20;

/* ── the KDF, recorded rather than assumed ──────────────────────────────── */

/// Argon2id's parameters, as stored in `prompt_vault.kdf`.
///
/// Recorded per vault and read back on unlock because a future change to the
/// defaults must still open a vault made today. The string is also part of the
/// key-wrap's associated data, so a row whose `kdf` column was edited to a
/// different-but-valid set of numbers unwraps into nothing rather than into a
/// key that would silently fail on every body.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Kdf {
    /// 1 KiB blocks. 65536 is 64 MiB.
    pub m_cost: u32,
    /// Passes.
    pub t_cost: u32,
    /// Lanes.
    pub p_cost: u32,
}

impl Kdf {
    /// 64 MiB, three passes, one lane — §3.8's numbers. One lane on purpose:
    /// this runs on a laptop that may already be running ten agents, and the
    /// cost that matters against an offline attacker is memory, not cores.
    pub const CURRENT: Kdf = Kdf {
        m_cost: 65_536,
        t_cost: 3,
        p_cost: 1,
    };

    /// The string written to `prompt_vault.kdf`, and bound into the wrap's AD.
    pub fn label(self) -> String {
        format!(
            "argon2id-v19-m={},t={},p={}",
            self.m_cost, self.t_cost, self.p_cost
        )
    }

    /// Read a stored label back. An unrecognised one is refused rather than
    /// guessed at: deriving with the wrong parameters produces a key that fails
    /// to unwrap, which reads exactly like a wrong passphrase.
    pub fn parse(label: &str) -> Result<Kdf, String> {
        let rest = label
            .strip_prefix("argon2id-v19-")
            .ok_or_else(|| "that vault was made with a key-derivation this build does not know".to_string())?;
        let mut m = None;
        let mut t = None;
        let mut p = None;
        for part in rest.split(',') {
            let (k, v) = part
                .split_once('=')
                .ok_or_else(|| "that vault's kdf record is malformed".to_string())?;
            let v: u32 = v
                .parse()
                .map_err(|_| "that vault's kdf record is malformed".to_string())?;
            match k {
                "m" => m = Some(v),
                "t" => t = Some(v),
                "p" => p = Some(v),
                _ => {}
            }
        }
        let kdf = Kdf {
            m_cost: m.ok_or_else(|| "that vault's kdf record names no memory cost".to_string())?,
            t_cost: t.ok_or_else(|| "that vault's kdf record names no pass count".to_string())?,
            p_cost: p.ok_or_else(|| "that vault's kdf record names no lane count".to_string())?,
        };
        /* A stored record is data, so it is bounded before it is obeyed. 8 KiB
           of memory would derive a key in microseconds, which is a vault that
           looks sealed and is not. */
        /* Bounded at **both** ends. A stored record is data — an export file, a
           row from a peer, a hand-edited database — so the floor keeps a vault
           that only looks sealed from being opened in microseconds, and the
           ceiling keeps a hostile or damaged one from making an unlock allocate
           gigabytes or burn minutes per attempt.

           **Four times today's parameters, not an absolute number**, so a wall
           that deliberately set a stronger passphrase still imports, and a
           future change to `CURRENT` carries its ceiling with it rather than
           leaving a literal behind. Four is also what the worst case costs: 256
           MiB over twelve passes is a few seconds, on a call that holds the
           store's mutex. The alternative bound is worse, because Argon2's block
           allocation is infallible and a 4 GiB request is a `__fastfail` on a
           loaded laptop — the way this app has already died once. */
        if kdf.m_cost < 8 * 1024 || kdf.t_cost == 0 || kdf.p_cost == 0 {
            return Err("that vault's kdf record names parameters too weak to open it with".into());
        }
        if kdf.m_cost > 4 * Kdf::CURRENT.m_cost
            || kdf.t_cost > 4 * Kdf::CURRENT.t_cost
            || kdf.p_cost > 4 * Kdf::CURRENT.p_cost
        {
            return Err(
                "that vault's kdf record names parameters too expensive to open it with".into(),
            );
        }
        Ok(kdf)
    }
}

/* ── the pure half: AD encoding, blob layout, the cap ───────────────────── */

/// The associated data a body is sealed against.
///
/// **Length-prefixed, never concatenated.** `("ab", "c")` and `("a", "bc")` are
/// different prompts whose plain concatenation is `abc` both times, and an
/// implementation that joins its fields is one where a blob can be moved between
/// two rows that only *look* different. Each field is a `u32` little-endian
/// length and then its bytes; the stamp is fixed-width, so it needs no prefix.
pub fn body_ad(
    vault_id: &str,
    host: &str,
    session: &str,
    prompt_id: &str,
    first_at: i64,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(64);
    for part in [vault_id, host, session, prompt_id] {
        out.extend_from_slice(&(part.len() as u32).to_le_bytes());
        out.extend_from_slice(part.as_bytes());
    }
    out.extend_from_slice(&first_at.to_le_bytes());
    out
}

/// The associated data a wrapped data key is sealed against: which vault it is,
/// and the KDF record that derived its key-encryption key.
pub fn wrap_ad(vault_id: &str, kdf: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(48);
    for part in [vault_id, kdf] {
        out.extend_from_slice(&(part.len() as u32).to_le_bytes());
        out.extend_from_slice(part.as_bytes());
    }
    out
}

/// Cap a body at [`BODY_CAP`] on a character boundary.
///
/// An off-by-one here cuts a UTF-8 sequence in half and the caller then stores
/// bytes that are not text. The answer is a slice of the original, so nothing
/// is copied until the caller decides to.
pub fn capped(text: &str) -> (&str, bool) {
    if text.len() <= BODY_CAP {
        return (text, false);
    }
    let mut end = BODY_CAP;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    (&text[..end], true)
}

/// A sealed blob is `nonce(12) ‖ ciphertext ‖ tag(16)` in one column, so the
/// reader needs no second field and no implementer can quietly reuse a nonce.
#[derive(Debug, Clone, Copy)]
pub struct Blob<'a> {
    pub nonce: [u8; NONCE_LEN],
    pub rest: &'a [u8],
}

/// Split a blob, or say it is too short to be one.
pub fn split_blob(blob: &[u8]) -> Result<Blob<'_>, String> {
    if blob.len() < NONCE_LEN + 16 {
        return Err("that sealed body is too short to be one".into());
    }
    let mut nonce = [0u8; NONCE_LEN];
    nonce.copy_from_slice(&blob[..NONCE_LEN]);
    Ok(Blob {
        nonce,
        rest: &blob[NONCE_LEN..],
    })
}

fn cipher(key: &[u8; 32]) -> Result<LessSafeKey, String> {
    let unbound = UnboundKey::new(&CHACHA20_POLY1305, key)
        .map_err(|_| "the vault's data key is not usable".to_string())?;
    Ok(LessSafeKey::new(unbound))
}

fn random_nonce() -> Result<[u8; NONCE_LEN], String> {
    let mut nonce = [0u8; NONCE_LEN];
    SystemRandom::new()
        .fill(&mut nonce)
        .map_err(|_| "this machine's random source refused".to_string())?;
    Ok(nonce)
}

/// Seal `text` under `key`, binding `ad`, with a **fresh nonce every call**.
///
/// The fresh nonce is what makes two identical bodies two different blobs: the
/// same key, the same associated data, the same words, and no way to tell from
/// the disk that they were the same. It is generated here rather than passed in
/// so no caller can hold one across a loop.
pub fn seal_blob(key: &[u8; 32], ad: &[u8], text: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = cipher(key)?;
    let nonce = random_nonce()?;
    /* The plaintext lives in a `Zeroizing` buffer from the copy that makes it,
       so sealing does not leave a prompt's words in a freed page. */
    let mut buf = Zeroizing::new(text.to_vec());
    cipher
        .seal_in_place_append_tag(
            Nonce::assume_unique_for_key(nonce),
            Aad::from(ad),
            &mut *buf,
        )
        .map_err(|_| "the body could not be sealed".to_string())?;
    let mut out = Vec::with_capacity(NONCE_LEN + buf.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&buf);
    Ok(out)
}

/// Open one blob into bytes, or refuse.
///
/// The answer is `Zeroizing` all the way out. Two things are opened with this:
/// a prompt's body, which is text, and a vault's wrapped data key, which is 32
/// random bytes and almost never valid UTF-8. The binary half is the one an
/// implementation that only wrote a `String` helper would get wrong, and it
/// would get it wrong for *every* vault rather than occasionally.
pub fn open_raw(key: &[u8; 32], ad: &[u8], blob: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
    let split = split_blob(blob)?;
    let cipher = cipher(key)?;
    let mut buf = Zeroizing::new(split.rest.to_vec());
    let plain = cipher
        .open_in_place(
            Nonce::assume_unique_for_key(split.nonce),
            Aad::from(ad),
            &mut *buf,
        )
        /* One message for a wrong key, a moved blob and a flipped byte, because
           the caller can do nothing different about any of them and a message
           that distinguishes them is an oracle. */
        .map_err(|_| {
            "that sealed body did not open: it was not sealed by this vault, or it has been altered"
                .to_string()
        })?;
    let len = plain.len();
    buf.truncate(len);
    Ok(buf)
}

/// Open one body into text.
///
/// The text is the one value in this app that may not linger in a freed
/// allocation, so it is `Zeroizing<String>` and never a bare `String` until the
/// IPC boundary.
pub fn open_blob(key: &[u8; 32], ad: &[u8], blob: &[u8]) -> Result<Zeroizing<String>, String> {
    let mut buf = open_raw(key, ad, blob)?;
    match String::from_utf8(std::mem::take(&mut *buf)) {
        Ok(text) => Ok(Zeroizing::new(text)),
        Err(_) => Err("that sealed body is not text this wall wrote".into()),
    }
}

/// Derive a key-encryption key from a passphrase.
///
/// The output buffer is zeroizing and so is the passphrase the caller holds; the
/// only other copy is the 64 MiB Argon2id fills, which the crate zeroizes
/// because the `zeroize` feature is on.
fn derive(pass: &Passphrase, salt: &[u8], kdf: Kdf) -> Result<Zeroizing<[u8; 32]>, String> {
    let params = Params::new(kdf.m_cost, kdf.t_cost, kdf.p_cost, Some(32))
        .map_err(|e| format!("that vault's kdf parameters are not usable: {e}"))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = Zeroizing::new([0u8; 32]);
    argon
        .hash_password_into(pass.0.as_bytes(), salt, &mut out[..])
        .map_err(|e| format!("the passphrase could not be stretched: {e}"))?;
    Ok(out)
}

/// A passphrase, wrapped the moment it arrives and printed as nothing.
///
/// `Zeroizing<String>` on its own forwards `Debug` to the inner string, which is
/// exactly the shape of leak this phase may not have: one `log::debug!("{:?}")`
/// by somebody debugging an unlock would put a passphrase in `volery.log`. This
/// newtype exists for the `Debug` impl.
struct Passphrase(Zeroizing<String>);

impl Passphrase {
    fn new(raw: String) -> Self {
        Passphrase(Zeroizing::new(raw))
    }

    /// Refused here rather than by a caller, because every caller would have to
    /// remember and one would not.
    fn checked(self) -> Result<Self, String> {
        let chars = self.0.chars().count();
        if chars < MIN_PASSPHRASE {
            return Err(format!(
                "a passphrase must be at least {MIN_PASSPHRASE} characters, and this one is {chars}"
            ));
        }
        if chars > MAX_PASSPHRASE {
            return Err(format!(
                "that passphrase is more than {MAX_PASSPHRASE} characters"
            ));
        }
        Ok(self)
    }
}

impl std::fmt::Debug for Passphrase {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Passphrase(<redacted>)")
    }
}

/* ── the keyring ────────────────────────────────────────────────────────── */

#[derive(Default)]
struct Open {
    /// Vault id → data key. `Zeroizing` is the whole of "the key is
    /// memory-only": dropping the map entry zeroes the 32 bytes.
    keys: HashMap<String, Zeroizing<[u8; 32]>>,
    /// The vault a new body is sealed under. Set by create and by unlock (the
    /// newest vault that passphrase opened), cleared by lock and by expiry.
    active: Option<String>,
    /// When a person last did something that needed the key: unlock, or reading
    /// a body. Sealing an ingested prompt does not move it.
    touched: i64,
    /// Whether the idle watcher is running, so a second unlock does not start a
    /// second thread.
    watching: bool,
}

impl Open {
    fn expire(&mut self, now: i64) {
        if !self.keys.is_empty() && now.saturating_sub(self.touched) >= IDLE_MS {
            /* Dropping the values is what zeroizes them. */
            self.keys.clear();
            self.active = None;
        }
    }
}

/// The vault's in-memory half, managed by Tauri as one value.
///
/// `Arc` inside rather than managing an `Arc` itself: the idle watcher needs a
/// reference that does not keep the vault alive, and `Weak` is that reference.
/// A test that drops the state therefore stops the watcher too.
#[derive(Clone, Default)]
pub struct PromptVault(Arc<Inner>);

#[derive(Default)]
struct Inner {
    open: Mutex<Open>,
}

impl std::fmt::Debug for PromptVault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.0.open.lock() {
            Ok(open) => f
                .debug_struct("PromptVault")
                .field("unlocked", &open.keys.keys().collect::<Vec<_>>())
                .field("active", &open.active)
                .finish(),
            Err(_) => f.write_str("PromptVault(<wedged>)"),
        }
    }
}

impl PromptVault {
    /// Which vaults are open, in no particular order.
    pub fn unlocked(&self) -> Vec<String> {
        match self.0.open.lock() {
            Ok(open) => open.keys.keys().cloned().collect(),
            Err(_) => Vec::new(),
        }
    }

    fn lock_open(&self) -> Result<std::sync::MutexGuard<'_, Open>, String> {
        self.0
            .open
            .lock()
            .map_err(|_| "the prompt vault is wedged".to_string())
    }

    /// Put a key in and make it active, then make sure something will take it
    /// out again.
    fn insert(&self, vault_id: &str, key: Zeroizing<[u8; 32]>) -> Result<(), String> {
        let mut open = self.lock_open()?;
        open.keys.insert(vault_id.to_string(), key);
        open.active = Some(vault_id.to_string());
        open.touched = store::now();
        let watching = open.watching;
        open.watching = true;
        drop(open);
        if !watching {
            self.watch();
        }
        Ok(())
    }

    /// The idle watcher: one thread, started by the first unlock, gone once
    /// there is nothing left to expire.
    ///
    /// It holds a `Weak`, so it cannot keep the vault alive past the app. A
    /// timer of its own rather than an entry on the wall's one-second tick,
    /// because this is a lifetime about a secret and not a reading on a screen;
    /// tying it to a surface that might be closed would make the drop depend on
    /// what is drawn.
    fn watch(&self) {
        let weak: Weak<Inner> = Arc::downgrade(&self.0);
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_millis(WATCH_MS));
            let Some(inner) = weak.upgrade() else { return };
            let done = match inner.open.lock() {
                Ok(mut open) => {
                    open.expire(store::now());
                    if open.keys.is_empty() {
                        open.watching = false;
                        true
                    } else {
                        false
                    }
                }
                Err(_) => true,
            };
            if done {
                return;
            }
        });
    }

    /// Borrow a vault's data key for the length of one closure.
    ///
    /// `touch` is the idle clock: true from reading a body, false from sealing
    /// one. The key never leaves the lock, so a `lock()` cannot race a seal into
    /// using a key that has already been dropped.
    fn with_key<R>(
        &self,
        vault_id: &str,
        touch: bool,
        work: impl FnOnce(&[u8; 32]) -> R,
    ) -> Result<R, String> {
        let mut open = self.lock_open()?;
        let now = store::now();
        open.expire(now);
        let key = open
            .keys
            .get(vault_id)
            .ok_or_else(|| "that vault is locked".to_string())?;
        let out = work(key);
        if touch {
            open.touched = now;
        }
        Ok(out)
    }

    /// Seal one body under the active vault, or answer `None` when there is no
    /// key to seal it with.
    ///
    /// This is the ingest's only way in. The associated data is built here from
    /// the same five things the row will carry, so a caller cannot seal a body
    /// against the wrong binding by forgetting an argument: there is no
    /// argument to forget.
    pub fn seal_body(
        &self,
        host: &str,
        session: &str,
        prompt_id: &str,
        first_at: i64,
        text: &str,
    ) -> Option<(String, Vec<u8>, bool)> {
        let (capped, truncated) = capped(text);
        let mut open = self.0.open.lock().ok()?;
        open.expire(store::now());
        let vault_id = open.active.clone()?;
        let key = open.keys.get(&vault_id)?;
        let ad = body_ad(&vault_id, host, session, prompt_id, first_at);
        let blob = seal_blob(key, &ad, capped.as_bytes()).ok()?;
        Some((vault_id, blob, truncated))
    }

    /// Open one body. The one read of prompt text in the app.
    pub fn open_body(
        &self,
        vault_id: &str,
        host: &str,
        session: &str,
        prompt_id: &str,
        first_at: i64,
        blob: &[u8],
    ) -> Result<Zeroizing<String>, String> {
        let ad = body_ad(vault_id, host, session, prompt_id, first_at);
        self.with_key(vault_id, true, |key| open_blob(key, &ad, blob))?
    }

    /// Drop every key now. On lock, on quit, and nowhere else.
    pub fn lock(&self) {
        if let Ok(mut open) = self.0.open.lock() {
            open.keys.clear();
            open.active = None;
            open.touched = 0;
        }
    }

    /// Milliseconds until the keys expire, for a face that wants to say so.
    fn idle_left(&self) -> Option<i64> {
        let open = self.0.open.lock().ok()?;
        if open.keys.is_empty() {
            return None;
        }
        Some((open.touched + IDLE_MS - store::now()).max(0))
    }
}

/* ── what ingest decides ────────────────────────────────────────────────── */

/// What to do with one prompt's body, decided once.
///
/// A `Debug` that prints the state and the sizes and never the ciphertext: a
/// blob in a log line is not a leak, but a `{:?}` on this type is the obvious
/// place a future field holding text would end up, and this is the type that
/// must not be that place.
#[derive(Clone)]
pub(crate) struct Body {
    pub(crate) state: &'static str,
    pub(crate) vault_id: String,
    pub(crate) sealed: Option<Vec<u8>>,
    pub(crate) truncated: bool,
    /// Where the line still is: the transcript and the byte offset of the
    /// record. Carried on a **sealed** body too, because the write path may
    /// have to demote it to `locked` when the vault that sealed it has gone.
    pub(crate) locator: Option<(String, u64)>,
    /// When this body was sealed or its locator minted, **on this machine's
    /// clock**.
    ///
    /// The write path compares this against the stamp a forget or a reset
    /// leaves, to decide whether the gesture happened after this body was
    /// captured and therefore wins. It cannot be the prompt's own `at`: that is
    /// the clock of whichever machine wrote the transcript, and a session copied
    /// from a peer whose clock ran fast would slip past the stamp.
    pub(crate) captured_at: i64,
}

impl std::fmt::Debug for Body {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Body")
            .field("state", &self.state)
            .field("vault_id", &self.vault_id)
            .field("bytes", &self.sealed.as_ref().map(|b| b.len()))
            .field("truncated", &self.truncated)
            .field("locator", &self.locator.as_ref().map(|(p, o)| (p, o)))
            .field("captured_at", &self.captured_at)
            .finish()
    }
}

/// Decide one prompt's body while the text is still in hand.
///
/// The order is the design:
/// 1. **Withheld wins over everything.** A prompt whose redaction withheld the
///    text has no body to keep; sealing an empty string would be a row that
///    claims a body exists.
/// 2. **Sealed if a vault is unlocked**, which is the normal case after the
///    first unlock.
/// 3. **Locked with a locator otherwise** — including on a wall that has never
///    made a vault. Keeping the locator is what lets `seal pending` fill the
///    archive in later without a second walk of every transcript.
pub(crate) fn decide(
    vault: Option<&PromptVault>,
    host: &str,
    session: &str,
    prompt_id: &str,
    first_at: i64,
    redacted: &Redacted,
    path: &str,
    off: u64,
) -> Body {
    /* Taken once, before any decision, so the write path can tell a body
       captured before a forget from one captured after it. */
    let captured_at = store::now();
    if redacted.withheld {
        return Body {
            state: "withheld",
            vault_id: String::new(),
            sealed: None,
            truncated: false,
            locator: None,
            captured_at,
        };
    }
    if let Some((vault_id, blob, truncated)) = vault
        .and_then(|v| v.seal_body(host, session, prompt_id, first_at, &redacted.text))
    {
        return Body {
            state: "sealed",
            vault_id,
            sealed: Some(blob),
            truncated,
            locator: Some((path.to_string(), off)),
            captured_at,
        };
    }
    Body {
        state: "locked",
        vault_id: String::new(),
        sealed: None,
        truncated: false,
        locator: Some((path.to_string(), off)),
        captured_at,
    }
}

/* ── the vault table ────────────────────────────────────────────────────── */

/// One `prompt_vault` row, without its wrapped key.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultRecord {
    pub vault_id: String,
    pub created_at: i64,
    pub unlocked: bool,
}

/// What the face reads. **Never the passphrase, and never a key.**
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultState {
    pub vaults: Vec<VaultRecord>,
    /// The vault a new body is sealed under, when one is open.
    pub active: Option<String>,
    /// How long the keys have left before they drop themselves.
    pub idle_ms: Option<i64>,
    pub bodies: BodyCounts,
    /// Bodies waiting on a key: their transcripts still hold the text.
    pub locators: i64,
    pub min_passphrase: usize,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BodyCounts {
    pub sealed: i64,
    pub locked: i64,
    pub withheld: i64,
    pub deleted: i64,
    pub none: i64,
}

fn state_of(conn: &Connection, vault: &PromptVault) -> Result<VaultState, String> {
    let unlocked: Vec<String> = vault.unlocked();
    let rows = {
        let mut stmt = conn
            .prepare("SELECT vault_id, created_at FROM prompt_vault ORDER BY created_at")
            .map_err(|e| format!("prompt vault: read vaults: {e}"))?;
        let it = stmt
            .query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
            })
            .map_err(|e| format!("prompt vault: read vaults: {e}"))?;
        it.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("prompt vault: read vaults: {e}"))?
    };
    let vaults = rows
        .into_iter()
        .map(|(vault_id, created_at)| VaultRecord {
            unlocked: unlocked.contains(&vault_id),
            vault_id,
            created_at,
        })
        .collect();

    let mut bodies = BodyCounts::default();
    {
        let mut stmt = conn
            .prepare("SELECT body_state, COUNT(*) FROM prompt_fact GROUP BY body_state")
            .map_err(|e| format!("prompt vault: count bodies: {e}"))?;
        let it = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .map_err(|e| format!("prompt vault: count bodies: {e}"))?;
        for row in it {
            let (state, n) = row.map_err(|e| format!("prompt vault: count bodies: {e}"))?;
            match state.as_str() {
                "sealed" => bodies.sealed = n,
                "locked" => bodies.locked = n,
                "withheld" => bodies.withheld = n,
                "deleted" => bodies.deleted = n,
                "none" => bodies.none = n,
                _ => {}
            }
        }
    }
    let locators: i64 = conn
        .query_row("SELECT COUNT(*) FROM prompt_locator", [], |r| r.get(0))
        .map_err(|e| format!("prompt vault: count locators: {e}"))?;

    let active = match vault.lock_open() {
        Ok(open) => open.active.clone(),
        Err(_) => None,
    };
    Ok(VaultState {
        vaults,
        active,
        idle_ms: vault.idle_left(),
        bodies,
        locators,
        min_passphrase: MIN_PASSPHRASE,
    })
}

fn mint_id() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| "this machine's random source refused".to_string())?;
    let mut out = String::with_capacity(32);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    Ok(out)
}

/// Make a vault, and leave it unlocked.
///
/// A wall may hold several: two walls each made one before they met, and
/// neither may be thrown away, because discarding a data key makes its bodies
/// unreadable for ever (§3.8).
///
/// The passphrase arrives as a plain `String` because Tauri deserializes it as
/// one; the first line of this function wraps it in `Zeroizing` and nothing
/// after that may name it. `unlock` has the same first line for the same
/// reason.
pub fn create(conn: &Connection, raw: String, vault: &PromptVault) -> Result<VaultState, String> {
    let pass = Passphrase::new(raw).checked()?;
    let vault_id = mint_id()?;
    let kdf = Kdf::CURRENT;
    let label = kdf.label();

    let mut salt = [0u8; SALT_LEN];
    SystemRandom::new()
        .fill(&mut salt)
        .map_err(|_| "this machine's random source refused".to_string())?;
    let mut data_key = Zeroizing::new([0u8; 32]);
    SystemRandom::new()
        .fill(&mut data_key[..])
        .map_err(|_| "this machine's random source refused".to_string())?;

    let kek = derive(&pass, &salt, kdf)?;
    /* `nonce ‖ ct ‖ tag` in the one column, and the nonce *also* in its own
       column because §17 has one. They are the same twelve bytes; unlock reads
       the prefix and checks it against the column, so a hand-edited row that
       disagrees is refused instead of half-trusted. */
    let wrapped = seal_blob(&kek, &wrap_ad(&vault_id, &label), &data_key[..])?;
    let nonce = split_blob(&wrapped)?.nonce;
    let now = store::now();
    conn.execute(
        "INSERT INTO prompt_vault (vault_id, salt, nonce, wrapped_key, kdf, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            vault_id,
            salt.as_slice(),
            nonce.as_slice(),
            wrapped,
            label,
            now
        ],
    )
    .map_err(|e| format!("prompt vault: {e}"))?;

    vault.insert(&vault_id, data_key)?;
    state_of(conn, vault)
}

/// Try a passphrase against every vault this wall holds.
///
/// A wrong one opens none and changes nothing — the vault stays sealed, which is
/// the property the acceptance item names. Several may open: the same passphrase
/// for each, or one after another with different ones. The newest that opened is
/// made active, because the gesture just made is the one being worked with.
pub fn unlock(conn: &Connection, raw: String, vault: &PromptVault) -> Result<VaultState, String> {
    let pass = Passphrase::new(raw).checked()?;
    let rows = {
        let mut stmt = conn
            /* Ascending, because `insert` makes the last one active: walked this
               way, the newest vault that this passphrase opens is the one a new
               body goes into. Descending leaves the oldest active, which is the
               opposite of what the comment below promises. */
            .prepare("SELECT vault_id, salt, nonce, wrapped_key, kdf FROM prompt_vault ORDER BY created_at, vault_id")
            .map_err(|e| format!("prompt vault: read vaults: {e}"))?;
        let it = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Vec<u8>>(1)?,
                    r.get::<_, Vec<u8>>(2)?,
                    r.get::<_, Vec<u8>>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })
            .map_err(|e| format!("prompt vault: read vaults: {e}"))?;
        it.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("prompt vault: read vaults: {e}"))?
    };
    if rows.is_empty() {
        return Err("this wall has no vault yet, so there is nothing to unlock: create one first".into());
    }

    let mut opened = 0usize;
    /* A vault this build cannot read — a kdf record from a future version, a
       salt of the wrong size out of an export file, a record damaged on disk —
       is skipped rather than allowed to fail the whole unlock: a wall holding
       one of those *and* one of ours must still open ours. It is only reported
       when nothing opened, because then it is the answer. */
    let mut unreadable = false;
    for (vault_id, salt, nonce, wrapped, label) in rows {
        let Ok(kdf) = Kdf::parse(&label) else {
            unreadable = true;
            continue;
        };
        let Ok(kek) = derive(&pass, &salt, kdf) else {
            unreadable = true;
            continue;
        };
        let Ok(blob) = split_blob(&wrapped) else {
            continue;
        };
        if blob.nonce[..] != nonce[..] {
            continue;
        }
        /* A wrong key fails here — the tag does not verify — so a passphrase
           that does not open this vault costs one derivation and changes
           nothing. Binary, not text: a data key is random bytes and almost
           never UTF-8. */
        let Ok(raw) = open_raw(&kek, &wrap_ad(&vault_id, &label), &wrapped) else {
            continue;
        };
        let Ok(array) = <[u8; 32]>::try_from(raw.as_slice()) else {
            continue;
        };
        vault.insert(&vault_id, Zeroizing::new(array))?;
        opened += 1;
    }
    if opened == 0 {
        if unreadable {
            return Err(
                "this wall holds a vault record this build cannot use, and no other vault took \
                 that passphrase"
                    .into(),
            );
        }
        return Err("that passphrase opens none of the vaults on this wall".into());
    }
    state_of(conn, vault)
}

/* ── seal pending ───────────────────────────────────────────────────────── */

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SealReport {
    pub sealed: i64,
    pub withheld: i64,
    /// Locators that no longer resolve: the transcript is gone, or the line at
    /// that offset is a different record. Left for a later attempt, and named
    /// here rather than deleted, because a body deleted for being unreadable now
    /// is a body nobody can ever recover.
    pub unresolved: i64,
    pub unresolved_ids: Vec<String>,
    /// Locators still waiting, whatever the reason.
    pub remaining: i64,
}

struct Pending {
    host: String,
    prompt_id: String,
    path: String,
    off: u64,
    session: String,
    at: i64,
}

fn locator_page(
    conn: &Connection,
    after: Option<&(String, String)>,
) -> Result<Vec<Pending>, String> {
    /* A keyset page rather than `LIMIT` with an offset: each locator is looked
       at once per call even if sealing changes the table under the statement. */
    let mut stmt = conn
        .prepare(
            "SELECT l.host, l.prompt_id, l.path, l.off, f.session, f.at
               FROM prompt_locator l
               JOIN prompt_fact f ON f.host = l.host AND f.prompt_id = l.prompt_id
              WHERE ?1 IS NULL OR l.host > ?1 OR (l.host = ?1 AND l.prompt_id > ?2)
              ORDER BY l.host, l.prompt_id
              LIMIT ?3",
        )
        .map_err(|e| format!("prompt vault: read locators: {e}"))?;
    let (host, id) = match after {
        Some((h, p)) => (Some(h.as_str()), p.as_str()),
        None => (None, ""),
    };
    let it = stmt
        .query_map(params![host, id, SEAL_CHUNK as i64], |r| {
            Ok(Pending {
                host: r.get(0)?,
                prompt_id: r.get(1)?,
                path: r.get(2)?,
                off: r.get::<_, i64>(3)? as u64,
                session: r.get(4)?,
                at: r.get(5)?,
            })
        })
        .map_err(|e| format!("prompt vault: read locators: {e}"))?;
    it.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("prompt vault: read locators: {e}"))
}

/// The line a locator names, if it is still there.
///
/// **Bounded at the same 256 KB `prompt_of` refuses to parse.** A transcript that
/// has been replaced rather than appended to can leave an offset pointing into
/// the middle of anything, and a read that follows it to a newline with no cap
/// is the one unbounded read in this file.
fn line_at(path: &str, off: u64) -> Option<String> {
    let file = File::open(path).ok()?;
    let mut file = BufReader::new(file);
    file.seek(SeekFrom::Start(off)).ok()?;
    let mut buf = Vec::new();
    let mut limited = file.take(crate::sessions::MAX_PROMPT_BYTES as u64 + 1);
    let read = limited.read_until(b'\n', &mut buf).ok()?;
    if read == 0 {
        return None;
    }
    /* The newline comes off **before** the length is judged: a record of exactly
       the cap is one `fold` accepts, and measuring it with its terminator would
       leave it unresolved for ever. */
    while matches!(buf.last(), Some(b'\n') | Some(b'\r')) {
        buf.pop();
    }
    if buf.is_empty() || buf.len() > crate::sessions::MAX_PROMPT_BYTES {
        return None;
    }
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// One locator resolved, ready to write.
struct Sealed {
    host: String,
    prompt_id: String,
    vault_id: String,
    blob: Vec<u8>,
    truncated: bool,
}

/// One locator that could not be resolved this time round: counted, and named
/// up to a bound so a person can go and look at one.
fn unresolved(report: &mut SealReport, prompt_id: &str) {
    report.unresolved += 1;
    if report.unresolved_ids.len() < NAMED_UNRESOLVED {
        report.unresolved_ids.push(prompt_id.to_string());
    }
}

/// Seal every body that was ingested while the vault was locked.
///
/// The store lock is taken for a page of locators and released before any file
/// is opened, then taken again for the page's one transaction — the same shape
/// `analytics::pass` keeps, and the reason it is a function over `Store` rather
/// than over `Connection`.
pub fn seal_waiting(store: &Store, vault: &PromptVault) -> Result<SealReport, String> {
    if vault.unlocked().is_empty() {
        return Err("the vault is locked, so unlock it before sealing what waits".into());
    }
    let mut report = SealReport::default();
    let mut after: Option<(String, String)> = None;

    loop {
        let page = {
            let conn = store
                .0
                .lock()
                .map_err(|_| "the store is wedged".to_string())?;
            locator_page(&conn, after.as_ref())?
        };
        if page.is_empty() {
            break;
        }
        after = page
            .last()
            .map(|p| (p.host.clone(), p.prompt_id.clone()));

        /* File IO and the KDF-free sealing: no store lock held. */
        let mut sealed: Vec<Sealed> = Vec::new();
        let mut withheld: Vec<(String, String)> = Vec::new();
        for loc in &page {
            let Some(line) = line_at(&loc.path, loc.off) else {
                unresolved(&mut report, &loc.prompt_id);
                continue;
            };
            /* **The record must still be this prompt.** A transcript replaced
               rather than appended to leaves an offset pointing at a different
               line, and sealing that under this row's associated data would put
               one prompt's words in another prompt's body — the one mistake
               this table's AD cannot catch, because the AD comes from the row
               and not from the line. */
            let crate::sessions::Folded::Prompt { text, record, .. } =
                crate::sessions::fold(&line)
            else {
                unresolved(&mut report, &loc.prompt_id);
                continue;
            };
            let pick = |k: &str| record.get(k).and_then(|v| v.as_str()).unwrap_or("");
            let id = match pick("promptId") {
                "" => pick("uuid"),
                id => id,
            };
            let session = pick("sessionId");
            if id != loc.prompt_id || (!session.is_empty() && session != loc.session) {
                unresolved(&mut report, &loc.prompt_id);
                continue;
            }
            let redacted = crate::redact::redact(&text);
            if redacted.withheld {
                withheld.push((loc.host.clone(), loc.prompt_id.clone()));
                continue;
            }
            let Some((vault_id, blob, truncated)) =
                vault.seal_body(&loc.host, &loc.session, &loc.prompt_id, loc.at, &redacted.text)
            else {
                /* The key expired mid-pass. Stop rather than write half the
                   archive and report a success that is not one. */
                return Err(
                    "the vault locked itself part-way through, so unlock it and seal again".into(),
                );
            };
            sealed.push(Sealed {
                host: loc.host.clone(),
                prompt_id: loc.prompt_id.clone(),
                vault_id,
                blob,
                truncated,
            });
        }

        {
            let mut conn = store
                .0
                .lock()
                .map_err(|_| "the store is wedged".to_string())?;
            let tx = conn
                .transaction()
                .map_err(|e| format!("prompt vault: begin: {e}"))?;
            {
                /* The state guard is what makes a chunk idempotent: a `forget`
                   that ran between the page being read and this write leaves
                   `deleted`, and a seal that ignored that would resurrect a body
                   the person asked to be rid of. */
                let mut update = tx
                    .prepare(
                        "UPDATE prompt_fact
                            SET vault_id = ?3, body_state = 'sealed',
                                body_truncated = ?4, body_sealed = ?5
                          WHERE host = ?1 AND prompt_id = ?2 AND body_state = 'locked'",
                    )
                    .map_err(|e| format!("prompt vault: seal: {e}"))?;
                let mut drop_locator = tx
                    .prepare("DELETE FROM prompt_locator WHERE host = ?1 AND prompt_id = ?2")
                    .map_err(|e| format!("prompt vault: seal: {e}"))?;
                let mut mark_withheld = tx
                    .prepare(
                        "UPDATE prompt_fact SET body_state = 'withheld'
                          WHERE host = ?1 AND prompt_id = ?2 AND body_state = 'locked'",
                    )
                    .map_err(|e| format!("prompt vault: seal: {e}"))?;
                for s in &sealed {
                    let wrote = update
                        .execute(params![
                            s.host,
                            s.prompt_id,
                            s.vault_id,
                            i64::from(s.truncated),
                            s.blob,
                        ])
                        .map_err(|e| format!("prompt vault: seal: {e}"))?;
                    if wrote > 0 {
                        report.sealed += 1;
                    }
                    drop_locator
                        .execute(params![s.host, s.prompt_id])
                        .map_err(|e| format!("prompt vault: seal: {e}"))?;
                }
                for (host, prompt_id) in &withheld {
                    /* Guarded like the seal above: a forget that landed between
                       the page and this transaction leaves `deleted`, and a
                       report that counted it anyway would claim work nobody
                       did. */
                    let wrote = mark_withheld
                        .execute(params![host, prompt_id])
                        .map_err(|e| format!("prompt vault: seal: {e}"))?;
                    drop_locator
                        .execute(params![host, prompt_id])
                        .map_err(|e| format!("prompt vault: seal: {e}"))?;
                    if wrote > 0 {
                        report.withheld += 1;
                    }
                }
            }
            tx.commit()
                .map_err(|e| format!("prompt vault: commit: {e}"))?;
        }
        if page.len() < SEAL_CHUNK {
            break;
        }
    }

    let conn = store
        .0
        .lock()
        .map_err(|_| "the store is wedged".to_string())?;
    report.remaining = conn
        .query_row("SELECT COUNT(*) FROM prompt_locator", [], |r| r.get(0))
        .map_err(|e| format!("prompt vault: count locators: {e}"))?;
    Ok(report)
}

/* ── forget, reset ──────────────────────────────────────────────────────── */

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgetReport {
    /// Sealed bodies deleted.
    pub bodies: i64,
    /// Rows whose form was kept and whose state became `deleted`.
    pub marked: i64,
    /// One outbox row per deleted body, for the peers that hold a copy.
    pub tombstones: i64,
    /// Hall entries whose body went with it. §19: "a `forget prompts` removes
    /// its body and its hall entry; the counts remain" — a favourite outlives a
    /// *prune*, and a forget is not one.
    pub favourites: i64,
}

/// Delete every body, keep every count.
///
/// The tombstones are the durable half: a peer that was offline applies them
/// when it returns, so a delete is not a message that can be missed. They are
/// written here rather than when a peer asks because the wall that forgot is the
/// only thing that knows the deletion happened.
pub fn forget(conn: &Connection) -> Result<ForgetReport, String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("prompt vault: forget: {e}"))?;
    let now = store::now();
    let bodies: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM prompt_fact WHERE body_sealed IS NOT NULL",
            [],
            |r| r.get(0),
        )
        .map_err(|e| format!("prompt vault: forget: {e}"))?;
    let tombstones = tx
        .execute(
            "INSERT INTO prompt_tombstone (owner_host, prompt_id, at, reason, acked)
             SELECT host, prompt_id, ?1, 'forget', ''
               FROM prompt_fact WHERE body_sealed IS NOT NULL
             ON CONFLICT(owner_host, prompt_id) DO UPDATE
                SET at = excluded.at, reason = excluded.reason, acked = ''",
            params![now],
        )
        .map_err(|e| format!("prompt vault: forget: {e}"))? as i64;
    /* The stamp the ingest reads before it writes a body: everything said at or
       before this moment is not sealed by a pass that was already running. */
    tx.execute(
        "INSERT OR REPLACE INTO prompt_forget (id, at) VALUES (1, ?1)",
        params![now],
    )
    .map_err(|e| format!("prompt vault: forget: {e}"))?;
    let favourites = tx
        .execute(
            "DELETE FROM prompt_favourite
              WHERE EXISTS (SELECT 1 FROM prompt_fact f
                             WHERE f.host = prompt_favourite.host
                               AND f.prompt_id = prompt_favourite.prompt_id
                               AND f.body_state IN ('sealed', 'locked', 'withheld'))",
            [],
        )
        .map_err(|e| format!("prompt vault: forget: {e}"))? as i64;
    /* Every state that ever held a body goes to `deleted`, because `none` is
       the one state that means "analytics never captured this" and a row that
       was captured is not that any more. A `locked` row's locator goes with it
       or `seal pending` would quietly put the body back. */
    let marked = tx
        .execute(
            "UPDATE prompt_fact
                SET body_sealed = NULL, body_state = 'deleted'
              WHERE body_state IN ('sealed', 'locked', 'withheld')",
            [],
        )
        .map_err(|e| format!("prompt vault: forget: {e}"))? as i64;
    tx.execute("DELETE FROM prompt_locator", [])
        .map_err(|e| format!("prompt vault: forget: {e}"))?;
    tx.commit()
        .map_err(|e| format!("prompt vault: forget: {e}"))?;
    Ok(ForgetReport {
        bodies,
        marked,
        tombstones,
        favourites,
    })
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetReport {
    pub vaults: i64,
    pub bodies: i64,
    pub tombstones: i64,
    /// Favourite notes, which were sealed under the same key.
    pub notes: i64,
}

/// Throw the key away, and every body it opened.
///
/// There is no recovery and that is the design: a forgotten passphrase is a lost
/// archive, and this is the deliberate version of it. The confirmation is an
/// argument rather than a dialog here because the command is not the face.
pub fn reset(conn: &Connection, vault: &PromptVault, confirm: bool) -> Result<ResetReport, String> {
    if !confirm {
        return Err(
            "resetting deletes the key and every sealed prompt, and nothing can bring them back, and \
             the call must say confirm"
                .into(),
        );
    }
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("prompt vault: reset: {e}"))?;
    let now = store::now();
    /* The same stamp as `forget`, for the same reason: a pass holding bodies
       sealed a moment ago must not write them under a vault this transaction
       is about to delete. */
    tx.execute(
        "INSERT OR REPLACE INTO prompt_forget (id, at) VALUES (1, ?1)",
        params![now],
    )
    .map_err(|e| format!("prompt vault: reset: {e}"))?;
    let bodies: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM prompt_fact WHERE body_sealed IS NOT NULL",
            [],
            |r| r.get(0),
        )
        .map_err(|e| format!("prompt vault: reset: {e}"))?;
    let tombstones = tx
        .execute(
            "INSERT INTO prompt_tombstone (owner_host, prompt_id, at, reason, acked)
             SELECT host, prompt_id, ?1, 'reset', ''
               FROM prompt_fact WHERE body_sealed IS NOT NULL
             ON CONFLICT(owner_host, prompt_id) DO UPDATE
                SET at = excluded.at, reason = excluded.reason, acked = ''",
            params![now],
        )
        .map_err(|e| format!("prompt vault: reset: {e}"))? as i64;
    tx.execute(
        "UPDATE prompt_fact
            SET body_sealed = NULL, body_state = 'deleted', body_truncated = 0
          WHERE body_state IN ('sealed', 'locked', 'withheld')",
        [],
    )
    .map_err(|e| format!("prompt vault: reset: {e}"))?;
    tx.execute("DELETE FROM prompt_locator", [])
        .map_err(|e| format!("prompt vault: reset: {e}"))?;
    let notes = tx
        .execute(
            "UPDATE prompt_favourite SET note_sealed = NULL WHERE note_sealed IS NOT NULL",
            [],
        )
        .map_err(|e| format!("prompt vault: reset: {e}"))? as i64;
    let vaults = tx
        .execute("DELETE FROM prompt_vault", [])
        .map_err(|e| format!("prompt vault: reset: {e}"))? as i64;
    tx.commit()
        .map_err(|e| format!("prompt vault: reset: {e}"))?;
    /* And the key goes with the record. Anything less and a "reset" leaves a
       copy of the key in this process able to read a backup taken a minute ago. */
    vault.lock();
    Ok(ResetReport {
        vaults,
        bodies,
        tombstones,
        notes,
    })
}

/* ── overriding a kind, which moves the rollup in the same transaction ──── */

/// One correction, and the counts moving with it.
///
/// §3.8: "the old kind's counts go down, the new kind's go up, so the mix, the
/// redirect rate and the nudge rate follow the correction rather than going on
/// counting the automatic answer." Which rollup row that is comes off the fact,
/// which is why `prompt_fact` carries `hour`, `account` and `provider` beside its
/// own fields.
pub fn override_kind(
    conn: &Connection,
    host: &str,
    prompt_id: &str,
    kind: &str,
) -> Result<(), String> {
    if !crate::prompt::KINDS.contains(&kind) {
        return Err(format!("`{kind}` is not one of the prompt kinds"));
    }
    let fact = conn
        .query_row(
            "SELECT hour, account, provider, project, source, kind, kind_override,
                    chars, words, lines, code_lines, questions, fences, images,
                    redactions, withheld
               FROM prompt_fact WHERE host = ?1 AND prompt_id = ?2",
            params![host, prompt_id],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, Option<String>>(6)?,
                    r.get::<_, i64>(7)?,
                    r.get::<_, i64>(8)?,
                    r.get::<_, i64>(9)?,
                    r.get::<_, i64>(10)?,
                    r.get::<_, i64>(11)?,
                    r.get::<_, i64>(12)?,
                    r.get::<_, i64>(13)?,
                    r.get::<_, i64>(14)?,
                    r.get::<_, i64>(15)?,
                ))
            },
        )
        .map_err(|_| "that prompt is not on this wall".to_string())?;
    let (hour, account, provider, project, source, kind_now, over, chars, words, lines,
        code_lines, questions, fences, images, redactions, withheld) = fact;
    let was = over.unwrap_or(kind_now);

    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("prompt vault: override: {e}"))?;
    tx.execute(
        "UPDATE prompt_fact SET kind_override = ?3 WHERE host = ?1 AND prompt_id = ?2",
        params![host, prompt_id, kind],
    )
    .map_err(|e| format!("prompt vault: override: {e}"))?;

    if was != kind {
        let band = crate::prompt::word_band(words as usize);
        let moved = tx
            .execute(
                "UPDATE prompt_hour SET
                   prompts = prompts - 1, chars = chars - ?8, words = words - ?9,
                   lines = lines - ?10, code_lines = code_lines - ?11,
                   questions = questions - ?12, fences = fences - ?13,
                   images = images - ?14, redactions = redactions - ?15,
                   withheld = withheld - ?16,
                   words_under_16 = words_under_16 - ?17,
                   words_under_64 = words_under_64 - ?18,
                   words_under_256 = words_under_256 - ?19,
                   words_under_1024 = words_under_1024 - ?20,
                   words_over_1024 = words_over_1024 - ?21
                 WHERE hour = ?1 AND host = ?2 AND account = ?3 AND provider = ?4
                   AND project = ?5 AND source = ?6 AND kind = ?7",
                params![
                    hour,
                    host,
                    account,
                    provider,
                    project,
                    source,
                    was,
                    chars,
                    words,
                    lines,
                    code_lines,
                    questions,
                    fences,
                    images,
                    redactions,
                    withheld,
                    i64::from(band == 0),
                    i64::from(band == 1),
                    i64::from(band == 2),
                    i64::from(band == 3),
                    i64::from(band == 4),
                ],
            )
            .map_err(|e| format!("prompt vault: override: {e}"))?;
        if moved == 0 {
            /* The rollup and the fact disagree. Refusing leaves the correction
               out and the numbers honest; inventing a row would add a prompt to
               a bucket that never counted one. */
            return Err(
                "that prompt's hourly rollup row is missing, so moving its counts would invent one"
                    .into(),
            );
        }
        tx.execute(
            "INSERT INTO prompt_hour
               (hour, host, account, provider, project, source, kind, prompts, chars, words,
                lines, code_lines, questions, fences, images, redactions, withheld,
                words_under_16, words_under_64, words_under_256, words_under_1024,
                words_over_1024)
             VALUES (?1,?2,?3,?4,?5,?6,?7,1,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21)
             ON CONFLICT(hour, host, account, provider, project, source, kind)
             DO UPDATE SET
               prompts = prompts + 1, chars = chars + excluded.chars,
               words = words + excluded.words, lines = lines + excluded.lines,
               code_lines = code_lines + excluded.code_lines,
               questions = questions + excluded.questions, fences = fences + excluded.fences,
               images = images + excluded.images, redactions = redactions + excluded.redactions,
               withheld = withheld + excluded.withheld,
               words_under_16 = words_under_16 + excluded.words_under_16,
               words_under_64 = words_under_64 + excluded.words_under_64,
               words_under_256 = words_under_256 + excluded.words_under_256,
               words_under_1024 = words_under_1024 + excluded.words_under_1024,
               words_over_1024 = words_over_1024 + excluded.words_over_1024",
            params![
                hour,
                host,
                account,
                provider,
                project,
                source,
                kind,
                chars,
                words,
                lines,
                code_lines,
                questions,
                fences,
                images,
                redactions,
                withheld,
                i64::from(band == 0),
                i64::from(band == 1),
                i64::from(band == 2),
                i64::from(band == 3),
                i64::from(band == 4),
            ],
        )
        .map_err(|e| format!("prompt vault: override: {e}"))?;
        /* A bucket with nothing left is a row that says a prompt happened. */
        tx.execute(
            "DELETE FROM prompt_hour
              WHERE hour = ?1 AND host = ?2 AND account = ?3 AND provider = ?4
                AND project = ?5 AND source = ?6 AND kind = ?7 AND prompts <= 0",
            params![hour, host, account, provider, project, source, was],
        )
        .map_err(|e| format!("prompt vault: override: {e}"))?;
    }
    tx.commit()
        .map_err(|e| format!("prompt vault: override: {e}"))?;
    Ok(())
}

/* ── the commands ───────────────────────────────────────────────────────── */

/// Every one is `async` and goes through `off_main`: Argon2id deliberately takes
/// a moment, and the main thread is the one that paints every card.

fn store_of(app: &AppHandle) -> tauri::State<'_, Store> {
    app.state::<Store>()
}

fn vault_of(app: &AppHandle) -> PromptVault {
    app.state::<PromptVault>().inner().clone()
}

#[tauri::command]
pub async fn create_vault(app: AppHandle, passphrase: String) -> Result<VaultState, String> {
    crate::off_main(move || {
        let vault = vault_of(&app);
        let store = store_of(&app);
        let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
        create(&conn, passphrase, &vault)
    })
    .await?
}

#[tauri::command]
pub async fn unlock_vault(app: AppHandle, passphrase: String) -> Result<VaultState, String> {
    crate::off_main(move || {
        let vault = vault_of(&app);
        let store = store_of(&app);
        let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
        unlock(&conn, passphrase, &vault)
    })
    .await?
}

#[tauri::command]
pub async fn lock_vault(app: AppHandle) -> Result<VaultState, String> {
    crate::off_main(move || {
        let vault = vault_of(&app);
        vault.lock();
        let store = store_of(&app);
        let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
        state_of(&conn, &vault)
    })
    .await?
}

#[tauri::command]
pub async fn vault_state(app: AppHandle) -> Result<VaultState, String> {
    crate::off_main(move || {
        let vault = vault_of(&app);
        let store = store_of(&app);
        let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
        state_of(&conn, &vault)
    })
    .await?
}

#[tauri::command]
pub async fn seal_pending(app: AppHandle) -> Result<SealReport, String> {
    crate::off_main(move || {
        let vault = vault_of(&app);
        let store = store_of(&app);
        seal_waiting(&store, &vault)
    })
    .await?
}

#[tauri::command]
pub async fn forget_prompts(app: AppHandle) -> Result<ForgetReport, String> {
    crate::off_main(move || {
        let store = store_of(&app);
        let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
        forget(&conn)
    })
    .await?
}

#[tauri::command]
pub async fn reset_vault(app: AppHandle, confirm: bool) -> Result<ResetReport, String> {
    crate::off_main(move || {
        let vault = vault_of(&app);
        let store = store_of(&app);
        let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
        reset(&conn, &vault, confirm)
    })
    .await?
}

#[tauri::command]
pub async fn override_prompt_kind(
    app: AppHandle,
    host: String,
    prompt_id: String,
    kind: String,
) -> Result<(), String> {
    crate::off_main(move || {
        let store = store_of(&app);
        let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
        override_kind(&conn, &host, &prompt_id, &kind)
    })
    .await?
}

/// What one body reads as, if the vault holding it is open.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptBody {
    pub state: String,
    /// The redacted text, unsealed. Absent for every state but `sealed`, and
    /// absent when the vault that sealed it is locked.
    pub text: Option<String>,
    pub truncated: bool,
}

/// **This is the one type in the module that holds unsealed prompt text**, so
/// it is the one that may not derive `Debug`: a `{:?}` on a command's answer, a
/// `dbg!` added while looking at something else, or a future tracing span would
/// put a prompt body in `volery.log`. The shape is printed and the words are
/// not, which is all a log line ever needs.
impl std::fmt::Debug for PromptBody {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PromptBody")
            .field("state", &self.state)
            .field("chars", &self.text.as_ref().map(|t| t.chars().count()))
            .field("truncated", &self.truncated)
            .finish()
    }
}

/// Read one prompt's body.
///
/// A body whose vault is not open answers `locked` rather than a fault: on a
/// wall that received an archive from a peer, that is the honest state and the
/// face asks for the passphrase. The text is deliberately converted to a plain
/// `String` only at the last moment, because this is the IPC boundary and a
/// value crossing it is a copy this process no longer controls.
#[tauri::command]
pub async fn prompt_body(
    app: AppHandle,
    host: String,
    prompt_id: String,
) -> Result<PromptBody, String> {
    crate::off_main(move || {
        let vault = vault_of(&app);
        let store = store_of(&app);
        let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
        let row = conn.query_row(
            "SELECT body_state, body_truncated, body_sealed, vault_id, session, at
               FROM prompt_fact WHERE host = ?1 AND prompt_id = ?2",
            params![host, prompt_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, Option<Vec<u8>>>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, i64>(5)?,
                ))
            },
        );
        let (state, truncated, sealed, vault_id, session, at) =
            row.map_err(|_| "that prompt is not on this wall".to_string())?;
        let Some(blob) = sealed else {
            return Ok(PromptBody {
                state,
                text: None,
                truncated: truncated != 0,
            });
        };
        match vault.open_body(&vault_id, &host, &session, &prompt_id, at, &blob) {
            Ok(text) => Ok(PromptBody {
                state: "sealed".into(),
                text: Some(text.to_string()),
                truncated: truncated != 0,
            }),
            Err(_) => Ok(PromptBody {
                state: "locked".into(),
                text: None,
                truncated: truncated != 0,
            }),
        }
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        crate::store::migrate(&conn).unwrap();
        conn
    }

    /// A passphrase long enough to be accepted, and different per test so a
    /// leaked constant cannot make two tests agree for the wrong reason.
    const PASS: &str = "correct horse battery staple";
    const OTHER: &str = "a different passphrase entirely";

    fn fact(conn: &Connection, host: &str, id: &str, at: i64, kind: &str, words: i64) {
        conn.execute(
            "INSERT INTO prompt_fact
               (host, prompt_id, at, hour, seen_count, session, card, project, source,
                account, provider, vault_id, kind, kind_override, chars, words, lines,
                fences, code_lines, images, questions, redactions, withheld,
                body_state, body_truncated, body_sealed)
             VALUES (?1,?2,?3,?4,1,'s1','','volery','terminal','unknown','unknown','',
                     ?5,NULL,?6,?7,1,0,0,0,0,0,0,'none',0,NULL)",
            params![host, id, at, fact_hour(at), kind, words * 6, words],
        )
        .unwrap();
    }

    fn fact_hour(at: i64) -> i64 {
        at - at % 3_600_000
    }

    /// A prompt ingested while the vault was locked, which is the only state that
    /// ever has a locator. The ingest writes both together; a test that wrote
    /// only the locator would be sealing a row `seal waiting` refuses to touch,
    /// because its update is guarded on `body_state = 'locked'`.
    fn locked_fact(conn: &Connection, id: &str, at: i64) {
        fact(conn, "h", id, at, "task", 4);
        conn.execute(
            "UPDATE prompt_fact SET body_state = 'locked' WHERE host = 'h' AND prompt_id = ?1",
            params![id],
        )
        .unwrap();
    }

    /* ── the pure parts ────────────────────────────────────────────────── */

    /// **Length prefixes, not concatenation.** Two rows whose fields *should*
    /// differ by where the split falls are the case an encoder without lengths
    /// gets wrong, and it gets it wrong silently.
    #[test]
    fn the_ad_cannot_be_re_split_between_fields() {
        let a = body_ad("v", "host", "ab", "c", 7);
        let b = body_ad("v", "host", "a", "bc", 7);
        assert_ne!(a, b, "shifting a byte between two fields changed nothing");
        assert_ne!(
            body_ad("v", "h", "s", "p", 7),
            body_ad("v", "h", "s", "p", 8),
            "the stamp is part of the binding"
        );
        assert_ne!(
            body_ad("v1", "h", "s", "p", 7),
            body_ad("v2", "h", "s", "p", 7),
            "the vault is part of the binding"
        );
    }

    #[test]
    fn the_kdf_label_round_trips_and_weak_parameters_are_refused() {
        assert_eq!(Kdf::parse(&Kdf::CURRENT.label()).unwrap(), Kdf::CURRENT);
        assert!(Kdf::parse("argon2id-v19-m=1024,t=3,p=1").is_err(), "8 MiB is too weak");
        assert!(Kdf::parse("argon2id-v19-m=65536,t=0,p=1").is_err());
        assert!(Kdf::parse("scrypt-m=1,t=1,p=1").is_err());
    }

    /// The cap lands on a character boundary, so a body is always valid text.
    ///
    /// The prefix is there because the two-byte case is not the one that bites:
    /// `BODY_CAP` is even, so a string of nothing but `é` happens to land on a
    /// boundary and an implementation that only truncated would pass. One byte
    /// of ASCII in front moves every following character one byte along, so the
    /// cap now falls *inside* one.
    #[test]
    fn the_cap_never_cuts_a_character_in_half() {
        let short = "hello";
        assert_eq!(capped(short), (short, false));

        let aligned = "é".repeat(BODY_CAP);
        let (cut, truncated) = capped(&aligned);
        assert!(truncated);
        assert_eq!(cut.len(), BODY_CAP, "an even cap on two-byte characters is a boundary");

        let misaligned = format!("a{}", "é".repeat(BODY_CAP));
        let (cut, truncated) = capped(&misaligned);
        assert!(truncated);
        assert_eq!(cut.len(), BODY_CAP - 1, "the cap did not step back to a boundary");
        assert!(cut.chars().all(|c| c == 'a' || c == 'é'), "a character was cut in half");
        assert!(!cut.is_empty());
    }

    /* ── sealing ───────────────────────────────────────────────────────── */

    #[test]
    fn a_body_seals_and_opens_and_nothing_else_changes_it() {
        let key = Zeroizing::new([7u8; 32]);
        let ad = body_ad("v", "h", "s", "p", 1);
        let blob = seal_blob(&key, &ad, b"add a redact module").unwrap();
        assert_eq!(
            &*open_blob(&key, &ad, &blob).unwrap(),
            "add a redact module"
        );

        let mut tampered = blob.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 1;
        assert!(open_blob(&key, &ad, &tampered).is_err(), "a one-byte tamper opened");
    }

    /// **Two identical bodies are two different blobs.** The nonce is fresh per
    /// seal, so the disk cannot be searched for a known prompt's ciphertext.
    #[test]
    fn two_identical_bodies_seal_to_different_blobs() {
        let key = Zeroizing::new([9u8; 32]);
        let ad = body_ad("v", "h", "s", "p", 1);
        let a = seal_blob(&key, &ad, b"the same words").unwrap();
        let b = seal_blob(&key, &ad, b"the same words").unwrap();
        assert_ne!(a, b);
        assert_ne!(split_blob(&a).unwrap().nonce, split_blob(&b).unwrap().nonce);
        assert_eq!(&*open_blob(&key, &ad, &a).unwrap(), "the same words");
        assert_eq!(&*open_blob(&key, &ad, &b).unwrap(), "the same words");
    }

    /// A blob moved onto another row does not open, which is the whole reason
    /// the associated data names the row.
    #[test]
    fn a_blob_moved_to_another_row_does_not_open() {
        let key = Zeroizing::new([3u8; 32]);
        let here = body_ad("v", "h", "s", "p1", 1);
        let there = body_ad("v", "h", "s", "p2", 1);
        let blob = seal_blob(&key, &here, b"mine").unwrap();
        assert!(open_blob(&key, &there, &blob).is_err());
    }

    /* ── the vault record ──────────────────────────────────────────────── */

    #[test]
    fn a_passphrase_under_twelve_characters_is_refused() {
        let conn = db();
        let vault = PromptVault::default();
        let err = create(&conn, "short".into(), &vault).unwrap_err();
        assert!(err.contains("12"), "{err}");
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM prompt_vault", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 0, "a refused passphrase still made a vault");
    }

    #[test]
    fn a_wrong_passphrase_opens_nothing_and_leaves_the_vault_sealed() {
        let conn = db();
        let vault = PromptVault::default();
        create(&conn, PASS.into(), &vault).unwrap();
        let sealed: Vec<u8> = conn
            .query_row("SELECT wrapped_key FROM prompt_vault", [], |r| r.get(0))
            .unwrap();
        vault.lock();
        assert!(vault.unlocked().is_empty());

        let err = unlock(&conn, OTHER.into(), &vault).unwrap_err();
        assert!(err.contains("opens none"), "{err}");
        assert!(vault.unlocked().is_empty(), "a wrong passphrase left a key in memory");
        let after: Vec<u8> = conn
            .query_row("SELECT wrapped_key FROM prompt_vault", [], |r| r.get(0))
            .unwrap();
        assert_eq!(sealed, after, "a failed unlock rewrote the record");

        unlock(&conn, PASS.into(), &vault).unwrap();
        assert_eq!(vault.unlocked().len(), 1);
    }

    #[test]
    fn a_body_reads_only_from_the_vault_that_sealed_it() {
        let conn = db();
        let vault = PromptVault::default();
        let first = create(&conn, PASS.into(), &vault).unwrap();
        let id = first.vaults[0].vault_id.clone();
        fact(&conn, "h", "p1", 1_700_000_000_000, "task", 4);
        let (vault_id, blob, truncated) = vault
            .seal_body("h", "s1", "p1", 1_700_000_000_000, "add a thing")
            .unwrap();
        assert_eq!(vault_id, id);
        assert!(!truncated);
        assert_eq!(
            &*vault
                .open_body(&id, "h", "s1", "p1", 1_700_000_000_000, &blob)
                .unwrap(),
            "add a thing"
        );
        let other = create(&conn, OTHER.into(), &vault).unwrap();
        let second = other
            .vaults
            .iter()
            .find(|v| v.vault_id != id)
            .unwrap()
            .vault_id
            .clone();
        assert!(
            vault
                .open_body(&second, "h", "s1", "p1", 1_700_000_000_000, &blob)
                .is_err(),
            "the other vault's key opened a body it did not seal"
        );
    }

    /// **Both keys survive.** `prompt_vault` is keyed by `vault_id` because two
    /// walls may each have made one, and a second record must never overwrite
    /// the first: discarding a data key makes its bodies unreadable for ever.
    #[test]
    fn two_vaults_both_open_and_neither_record_is_rewritten() {
        let conn = db();
        let vault = PromptVault::default();
        create(&conn, PASS.into(), &vault).unwrap();
        let before: Vec<(String, Vec<u8>)> = {
            let mut stmt = conn
                .prepare("SELECT vault_id, wrapped_key FROM prompt_vault")
                .unwrap();
            let it = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .unwrap();
            it.collect::<Result<Vec<_>, _>>().unwrap()
        };
        create(&conn, OTHER.into(), &vault).unwrap();
        let after: Vec<(String, Vec<u8>)> = {
            let mut stmt = conn
                .prepare("SELECT vault_id, wrapped_key FROM prompt_vault ORDER BY vault_id")
                .unwrap();
            let it = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .unwrap();
            it.collect::<Result<Vec<_>, _>>().unwrap()
        };
        assert_eq!(after.len(), 2, "the second vault replaced the first");
        for (id, wrapped) in &before {
            assert_eq!(
                after.iter().find(|(i, _)| i == id).map(|(_, w)| w),
                Some(wrapped),
                "an existing vault record was rewritten"
            );
        }

        /* Both keys, from one locked state, one passphrase at a time. */
        vault.lock();
        unlock(&conn, PASS.into(), &vault).unwrap();
        assert_eq!(vault.unlocked().len(), 1);
        unlock(&conn, OTHER.into(), &vault).unwrap();
        assert_eq!(vault.unlocked().len(), 2, "the first key was dropped by the second unlock");
    }

    /* ── ingest, both states ───────────────────────────────────────────── */

    /// Locked: the form is kept, the body is not, and a locator remembers where
    /// the text still is.
    #[test]
    fn a_locked_ingest_keeps_a_locator_and_no_body() {
        let vault = PromptVault::default();
        let redacted = crate::redact::redact("add a redact module");
        let body = decide(
            Some(&vault),
            "h",
            "s1",
            "p1",
            1_700_000_000_000,
            &redacted,
            "C:\\t\\s.jsonl",
            42,
        );
        assert_eq!(body.state, "locked");
        assert!(body.sealed.is_none());
        assert_eq!(
            body.locator,
            Some(("C:\\t\\s.jsonl".to_string(), 42))
        );
    }

    /// Unlocked: the body is sealed, and the text is nowhere in the blob.
    #[test]
    fn an_unlocked_ingest_seals_the_body() {
        let conn = db();
        let vault = PromptVault::default();
        create(&conn, PASS.into(), &vault).unwrap();
        let redacted = crate::redact::redact("add a redact module");
        let body = decide(
            Some(&vault),
            "h",
            "s1",
            "p1",
            1_700_000_000_000,
            &redacted,
            "C:\\t\\s.jsonl",
            42,
        );
        assert_eq!(body.state, "sealed");
        let blob = body.sealed.clone().unwrap();
        /* The locator is carried even though nothing will be written for it:
           the write path needs it if a forget or a reset lands first, and it is
           never stored on a row that stays sealed. */
        assert_eq!(
            body.locator,
            Some(("C:\\t\\s.jsonl".to_string(), 42)),
            "a sealed body kept no way back"
        );
        assert!(
            !String::from_utf8_lossy(&blob).contains("redact"),
            "the plaintext is in the blob"
        );
        let text = vault
            .open_body(
                &body.vault_id,
                "h",
                "s1",
                "p1",
                1_700_000_000_000,
                &blob,
            )
            .unwrap();
        assert_eq!(&*text, "add a redact module");
    }

    /// A withheld body has no blob and no locator: there is nothing worth
    /// keeping, and a locator would make `seal pending` look at it for ever.
    ///
    /// The `Redacted` is stood in rather than produced by the redactor, because
    /// what is under test is the *decision* and not the entropy backstop — whose
    /// own corpus lives in `redact.rs` and which would make this test a second,
    /// weaker copy of that one.
    #[test]
    fn a_withheld_body_keeps_its_counts_and_no_place_to_find_it() {
        let redacted = Redacted {
            text: String::new(),
            redactions: 4,
            withheld: true,
        };
        let body = decide(
            None,
            "h",
            "s1",
            "p1",
            1_700_000_000_000,
            &redacted,
            "C:\\t\\s.jsonl",
            42,
        );
        assert_eq!(body.state, "withheld");
        assert!(body.sealed.is_none());
        assert!(body.locator.is_none());
    }

    /* ── seal pending ──────────────────────────────────────────────────── */

    fn transcript(dir: &std::path::Path, name: &str, lines: &[String]) -> (String, Vec<u64>) {
        let path = dir.join(name);
        let mut out = String::new();
        let mut offsets = Vec::new();
        for line in lines {
            offsets.push(out.len() as u64);
            out.push_str(line);
            out.push('\n');
        }
        std::fs::write(&path, out).unwrap();
        (path.to_string_lossy().to_string(), offsets)
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("volery-vault-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn user_line(id: &str, at: &str, session: &str, text: &str) -> String {
        format!(
            r#"{{"type":"user","promptId":"{id}","sessionId":"{session}","timestamp":"{at}","cwd":"C:\\w","entrypoint":"sdk-cli","message":{{"content":{}}}}}"#,
            serde_json::to_string(text).unwrap()
        )
    }

    /// The whole point of the locator: a locked ingest becomes a sealed body
    /// once there is a key, and the locator goes away with it.
    #[test]
    fn a_locator_seals_its_line_and_is_deleted() {
        let dir = scratch("seal");
        let line = user_line("p1", "2026-05-01T10:00:00.000Z", "s1", "add a redact module");
        let (path, offs) = transcript(&dir, "a.jsonl", &[line]);
        let conn = db();
        let store = Store(Mutex::new(conn), dir.join("db"));
        locked_fact(&store.0.lock().unwrap(), "p1", 1_700_000_000_000);
        {
            let conn = store.0.lock().unwrap();
            conn.execute(
                "INSERT INTO prompt_locator (host, prompt_id, path, off) VALUES ('h','p1',?1,?2)",
                params![path, offs[0] as i64],
            )
            .unwrap();
        }
        let vault = PromptVault::default();
        create(&vault_stored(&store), PASS.into(), &vault).unwrap();

        let report = seal_waiting(&store, &vault).unwrap();
        assert_eq!(report.sealed, 1);
        assert_eq!(report.unresolved, 0);
        assert_eq!(report.remaining, 0);

        let conn = store.0.lock().unwrap();
        let (state, blob, vid): (String, Vec<u8>, String) = conn
            .query_row(
                "SELECT body_state, body_sealed, vault_id FROM prompt_fact",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(state, "sealed");
        let text = vault
            .open_body(&vid, "h", "s1", "p1", 1_700_000_000_000, &blob)
            .unwrap();
        assert_eq!(&*text, "add a redact module");
        let locators: i64 = conn
            .query_row("SELECT COUNT(*) FROM prompt_locator", [], |r| r.get(0))
            .unwrap();
        assert_eq!(locators, 0, "the locator outlived the body it found");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A transcript that is gone leaves its locator alone, and the answer says
    /// so instead of silently doing nothing.
    #[test]
    fn a_locator_whose_transcript_is_gone_is_left_and_named() {
        let dir = scratch("gone");
        let conn = db();
        let store = Store(Mutex::new(conn), dir.join("db"));
        locked_fact(&store.0.lock().unwrap(), "p1", 1_700_000_000_000);
        {
            let conn = store.0.lock().unwrap();
            conn.execute(
                "INSERT INTO prompt_locator (host, prompt_id, path, off) VALUES ('h','p1',?1,0)",
                params![dir.join("nope.jsonl").to_string_lossy().to_string()],
            )
            .unwrap();
        }
        let vault = PromptVault::default();
        create(&vault_stored(&store), PASS.into(), &vault).unwrap();

        let report = seal_waiting(&store, &vault).unwrap();
        assert_eq!(report.sealed, 0);
        assert_eq!(report.unresolved, 1);
        assert_eq!(report.unresolved_ids, vec!["p1".to_string()]);
        assert_eq!(report.remaining, 1, "the locator was deleted for being unreadable");
        let conn = store.0.lock().unwrap();
        let state: String = conn
            .query_row("SELECT body_state FROM prompt_fact", [], |r| r.get(0))
            .unwrap();
        assert_eq!(state, "locked", "its form did not survive");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// An offset that now points at a *different* prompt is not sealed under
    /// this row's binding.
    #[test]
    fn a_locator_pointing_at_another_prompt_is_unresolved() {
        let dir = scratch("moved");
        let line = user_line("p2", "2026-05-01T10:00:00.000Z", "s1", "someone else's words");
        let (path, offs) = transcript(&dir, "b.jsonl", &[line]);
        let conn = db();
        let store = Store(Mutex::new(conn), dir.join("db"));
        locked_fact(&store.0.lock().unwrap(), "p1", 1_700_000_000_000);
        {
            let conn = store.0.lock().unwrap();
            conn.execute(
                "INSERT INTO prompt_locator (host, prompt_id, path, off) VALUES ('h','p1',?1,?2)",
                params![path, offs[0] as i64],
            )
            .unwrap();
        }
        let vault = PromptVault::default();
        create(&vault_stored(&store), PASS.into(), &vault).unwrap();

        let report = seal_waiting(&store, &vault).unwrap();
        assert_eq!(report.sealed, 0);
        assert_eq!(report.unresolved, 1);
        let conn = store.0.lock().unwrap();
        let sealed: Option<Vec<u8>> = conn
            .query_row("SELECT body_sealed FROM prompt_fact", [], |r| r.get(0))
            .unwrap();
        assert!(sealed.is_none(), "another prompt's words were sealed as this one's");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// `create` needs the store's own connection; the seal tests keep the
    /// connection inside a `Mutex<Connection>` so the same discipline the
    /// commands use is what runs here.
    fn vault_stored(store: &Store) -> std::sync::MutexGuard<'_, Connection> {
        store.0.lock().unwrap()
    }

    /* ── forget and reset ──────────────────────────────────────────────── */

    fn sealed_fact(conn: &Connection, vault: &PromptVault, id: &str, at: i64) {
        fact(conn, "h", id, at, "task", 3);
        let (vault_id, blob, truncated) = vault
            .seal_body("h", "s1", id, at, "add a thing")
            .unwrap();
        conn.execute(
            "UPDATE prompt_fact SET vault_id = ?2, body_state = 'sealed',
                    body_truncated = ?3, body_sealed = ?4
              WHERE prompt_id = ?1",
            params![id, vault_id, i64::from(truncated), blob],
        )
        .unwrap();
    }

    /// Forgetting removes the bodies and nothing else: the counts stay, the
    /// state says `deleted` rather than `none`, and one outbox row per body
    /// waits for the peers that hold a copy.
    #[test]
    fn forget_keeps_every_count_and_writes_a_tombstone_per_body() {
        let conn = db();
        let vault = PromptVault::default();
        create(&conn, PASS.into(), &vault).unwrap();
        sealed_fact(&conn, &vault, "p1", 1_700_000_000_000);
        sealed_fact(&conn, &vault, "p2", 1_700_000_000_000);
        /* The rollup the two facts count in. Without it every `SUM` below is
           NULL over an empty table and the assertion is about SQLite's type
           inference rather than about forget. */
        conn.execute(
            "INSERT INTO prompt_hour
               (hour, host, account, provider, project, source, kind, prompts, chars, words,
                lines, code_lines, questions, fences, images, redactions, withheld,
                words_under_16, words_under_64, words_under_256, words_under_1024,
                words_over_1024)
             VALUES (?1,'h','unknown','unknown','volery','terminal','task',2,36,6,2,0,0,0,0,0,0,2,0,0,0,0)",
            params![fact_hour(1_700_000_000_000)],
        )
        .unwrap();
        let (before_prompts, before_words, before_hour): (i64, i64, i64) = conn
            .query_row(
                "SELECT SUM(prompts), SUM(words), COUNT(*) FROM prompt_hour",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();

        /* One favourite on a body that is being forgotten, and one on a prompt
           analytics never captured: only the first is a hall entry whose body
           went. */
        conn.execute(
            "INSERT INTO prompt_favourite (host, prompt_id, vault_id, title, note_sealed, tags, created_at)
             VALUES ('h','p1','', 'keep this', NULL, '[]', 1), ('h','p9','', 'not mine', NULL, '[]', 1)",
            [],
        )
        .unwrap();

        let report = forget(&conn).unwrap();
        assert_eq!(report.bodies, 2);
        assert_eq!(report.tombstones, 2);
        assert_eq!(report.favourites, 1);

        let (states, bodies, blobs): (i64, i64, i64) = conn
            .query_row(
                "SELECT SUM(body_state = 'deleted'), SUM(words), SUM(body_sealed IS NULL)
                   FROM prompt_fact",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(states, 2, "a forgotten body is `deleted`, not `none`");
        assert_eq!(bodies, 6, "the form counts went with the body");
        assert_eq!(blobs, 2, "a body survived the forget");

        let (after_prompts, after_words, after_hour): (i64, i64, i64) = conn
            .query_row(
                "SELECT SUM(prompts), SUM(words), COUNT(*) FROM prompt_hour",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            (after_prompts, after_words, after_hour),
            (before_prompts, before_words, before_hour),
            "forgetting moved the rollup"
        );

        let outbox: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM prompt_tombstone WHERE reason = 'forget' AND acked = ''",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(outbox, 2, "no tombstone for a peer to apply");

        let kept: String = conn
            .query_row("SELECT prompt_id FROM prompt_favourite", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            kept, "p9",
            "a favourite whose body was forgotten kept its hall entry, or one with no body lost it"
        );
    }

    /// A locked body's locator is the way it comes back. Forgetting must take
    /// that too, or `seal pending` resurrects what the person deleted.
    #[test]
    fn forget_takes_the_locators_with_it() {
        let conn = db();
        fact(&conn, "h", "p1", 1_700_000_000_000, "task", 3);
        conn.execute(
            "UPDATE prompt_fact SET body_state = 'locked' WHERE prompt_id = 'p1'",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO prompt_locator (host, prompt_id, path, off) VALUES ('h','p1','C:\\t.jsonl',0)",
            [],
        )
        .unwrap();
        forget(&conn).unwrap();
        let locators: i64 = conn
            .query_row("SELECT COUNT(*) FROM prompt_locator", [], |r| r.get(0))
            .unwrap();
        assert_eq!(locators, 0);
        let state: String = conn
            .query_row("SELECT body_state FROM prompt_fact", [], |r| r.get(0))
            .unwrap();
        assert_eq!(state, "deleted");
    }

    #[test]
    fn reset_needs_confirmation_and_then_takes_the_key_with_it() {
        let conn = db();
        let vault = PromptVault::default();
        create(&conn, PASS.into(), &vault).unwrap();
        sealed_fact(&conn, &vault, "p1", 1_700_000_000_000);
        assert!(reset(&conn, &vault, false).is_err());
        assert_eq!(vault.unlocked().len(), 1, "a refused reset locked the vault");
        let blobs: i64 = conn
            .query_row("SELECT COUNT(*) FROM prompt_fact WHERE body_sealed IS NOT NULL", [], |r| r.get(0))
            .unwrap();
        assert_eq!(blobs, 1);

        let report = reset(&conn, &vault, true).unwrap();
        assert_eq!(report.bodies, 1);
        assert_eq!(report.vaults, 1);
        assert_eq!(report.tombstones, 1);
        assert!(vault.unlocked().is_empty(), "the key outlived its vault record");

        let vaults: i64 = conn
            .query_row("SELECT COUNT(*) FROM prompt_vault", [], |r| r.get(0))
            .unwrap();
        assert_eq!(vaults, 0);
        let (state, words): (String, i64) = conn
            .query_row("SELECT body_state, words FROM prompt_fact", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!((state.as_str(), words), ("deleted", 3), "the form went with the key");
        let tombstone: String = conn
            .query_row(
                "SELECT reason FROM prompt_tombstone WHERE prompt_id = 'p1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tombstone, "reset");
    }

    /* ── overriding a kind ─────────────────────────────────────────────── */

    /// The correction follows the record: the old kind's bucket loses the
    /// prompt and the new one gains it, in one transaction.
    #[test]
    fn an_override_moves_the_rollup_counts() {
        let conn = db();
        let at = 1_700_000_000_000;
        fact(&conn, "h", "p1", at, "other", 4);
        conn.execute(
            "INSERT INTO prompt_hour
               (hour, host, account, provider, project, source, kind, prompts, chars, words,
                lines, code_lines, questions, fences, images, redactions, withheld,
                words_under_16, words_under_64, words_under_256, words_under_1024,
                words_over_1024)
             VALUES (?1,'h','unknown','unknown','volery','terminal','other',1,24,4,1,0,0,0,0,0,0,1,0,0,0,0)",
            params![fact_hour(at)],
        )
        .unwrap();

        override_kind(&conn, "h", "p1", "task").unwrap();

        let override_now: String = conn
            .query_row(
                "SELECT kind_override FROM prompt_fact WHERE prompt_id = 'p1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(override_now, "task");

        let (old_prompts, old_rows): (Option<i64>, i64) = conn
            .query_row(
                "SELECT MAX(prompts), COUNT(*) FROM prompt_hour WHERE kind = 'other'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(old_rows, 0, "the emptied bucket stayed as a row saying a prompt happened");
        assert_eq!(old_prompts, None);

        let (prompts, words, band): (i64, i64, i64) = conn
            .query_row(
                "SELECT prompts, words, words_under_16 FROM prompt_hour WHERE kind = 'task'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!((prompts, words, band), (1, 4, 1), "the new bucket did not receive the counts");

        /* And the total is unchanged: a correction moves a count, it does not
           add one. */
        let total: i64 = conn
            .query_row("SELECT SUM(prompts) FROM prompt_hour", [], |r| r.get(0))
            .unwrap();
        assert_eq!(total, 1);

        /* A second override moves it again, from the override rather than from
           the automatic kind. */
        override_kind(&conn, "h", "p1", "question").unwrap();
        let total: i64 = conn
            .query_row("SELECT SUM(prompts) FROM prompt_hour", [], |r| r.get(0))
            .unwrap();
        assert_eq!(total, 1, "overriding twice double-counted");
        let kind: String = conn
            .query_row(
                "SELECT kind FROM prompt_hour WHERE prompts > 0",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(kind, "question");
    }

    #[test]
    fn a_kind_outside_the_vocabulary_is_refused() {
        let conn = db();
        fact(&conn, "h", "p1", 1_700_000_000_000, "other", 4);
        assert!(override_kind(&conn, "h", "p1", "vibes").is_err());
        assert!(override_kind(&conn, "h", "nope", "task").is_err());
    }
}
