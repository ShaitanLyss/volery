//! One secret, kept where Windows already keeps secrets.
//!
//! An Azure DevOps personal access token, entered in the app because the two
//! credentials a machine already has are not always enough — see the ladder in
//! `azdo.rs`. This is the only secret Skein stores anywhere, and where it goes
//! was the whole of the design question.
//!
//! - **Not the wall's own database.** `store.rs` is a SQLite file in
//!   `%APPDATA%\dev.skein.studio` with no encryption at all, sitting beside
//!   every card and every turn. A PAT in a column there is a plaintext
//!   credential in a file whose whole purpose is to be read and copied around,
//!   and `portage.rs` exports layouts out of the same database.
//!
//! - **Not a DPAPI blob of our own.** `CryptProtectData` into a file beside the
//!   database would be encrypted at rest and would also be a format nobody but
//!   this app can see into: invisible to the person whose credential it is, and
//!   revocable only through the app that wrote it. A credential you cannot find
//!   and delete without the cooperation of the thing holding it is the shape of
//!   this that would deserve suspicion.
//!
//! - **The Windows Credential Manager**, therefore. It is DPAPI underneath, so
//!   the encryption is the same; it is the vault Git Credential Manager already
//!   keeps this org's other token in, so it is where somebody would think to
//!   look; and it is listed in Control Panel → Credential Manager → Windows
//!   Credentials, so the answer to "what has Skein got of mine, and how do I
//!   take it back" is a thing you can do without Skein's help.
//!
//! **The target name keeps the `skein` identity on purpose.** Same argument as
//! `identifier: "dev.skein.studio"` in CLAUDE.md: this is a name the *disk*
//! depends on, and the visible rename to Volery was made with the new name
//! explicitly provisional. A credential keyed to a product name that changes
//! again is a token that silently disappears on upgrade and reads as the app
//! having forgotten it.
//!
//! Non-Windows arms return errors rather than silently no-oping, the same
//! convention the job objects and the `to_screen` arithmetic follow.

/// Where the token lives in the vault. Shaped like the urls GCM uses for its
/// own entries so it sorts beside them in Credential Manager.
#[cfg(windows)]
const TARGET: &str = "dev.skein.studio/azdo-pat";

/// What the entry says it is for, to somebody reading the vault rather than the
/// code. Not a secret and not used to find the entry.
#[cfg(windows)]
const WHO: &str = "azure devops (volery)";

/* ── windows ───────────────────────────────────────────────────────────────*/

#[cfg(windows)]
pub fn store(pat: &str) -> Result<(), String> {
    store_at(TARGET, WHO, pat)
}

/// The same vault, for a caller that brings its own target.
///
/// Added when the Spotify refresh token wanted this treatment and this
/// reasoning (`spotify.rs`). It is a second *entry*, deliberately not a second
/// mechanism: one place holds the unsafe block, one place decides the
/// persistence, and Credential Manager lists both under names that sort
/// together. Anything else this app ever has to keep belongs here too.
#[cfg(windows)]
pub fn store_at(target: &str, who: &str, pat: &str) -> Result<(), String> {
    use windows::core::{HSTRING, PWSTR};
    use windows::Win32::Security::Credentials::{
        CredWriteW, CREDENTIALW, CRED_MAX_CREDENTIAL_BLOB_SIZE, CRED_PERSIST_LOCAL_MACHINE,
        CRED_TYPE_GENERIC,
    };

    let pat = pat.trim();
    if pat.is_empty() {
        return Err("that is an empty token".into());
    }
    /* The blob is the token's UTF-8 bytes. Nothing but this module reads it, so
       the encoding is ours to pick, and picking the one the rest of the app is
       already in means no conversion on the path that matters. */
    let mut blob = pat.as_bytes().to_vec();
    if blob.len() > CRED_MAX_CREDENTIAL_BLOB_SIZE as usize {
        return Err(format!(
            "that token is {} bytes and the vault holds {}",
            blob.len(),
            CRED_MAX_CREDENTIAL_BLOB_SIZE
        ));
    }

    let target = HSTRING::from(target);
    let who = HSTRING::from(who);
    let cred = CREDENTIALW {
        Type: CRED_TYPE_GENERIC,
        TargetName: PWSTR(target.as_ptr() as *mut u16),
        UserName: PWSTR(who.as_ptr() as *mut u16),
        CredentialBlobSize: blob.len() as u32,
        CredentialBlob: blob.as_mut_ptr(),
        /* Local machine rather than enterprise: this token is for the Azure
           DevOps organisation whose repositories are on *this* wall, and a
           credential that roams to every machine you sign into is a wider
           blast radius than anybody asked for. */
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        ..Default::default()
    };

    /* SAFETY: every pointer in `cred` outlives the call — `target`, `who` and
       `blob` are all still owned here — and `CredWriteW` copies what it is
       given rather than taking ownership. The two `PWSTR`s are cast from
       `HSTRING`'s null-terminated buffer, which the API reads and does not
       write. */
    unsafe { CredWriteW(&cred, 0) }.map_err(|e| format!("windows would not store the token: {e}"))
}

#[cfg(windows)]
pub fn read() -> Option<String> {
    read_at(TARGET)
}

#[cfg(windows)]
pub fn read_at(target: &str) -> Option<String> {
    use windows::core::HSTRING;
    use windows::Win32::Security::Credentials::{CredFree, CredReadW, CREDENTIALW, CRED_TYPE_GENERIC};

    let target = HSTRING::from(target);
    let mut out: *mut CREDENTIALW = std::ptr::null_mut();
    /* SAFETY: `out` is a null pointer the API fills with an allocation of its
       own, which is freed below on both paths. Failure — including the ordinary
       ERROR_NOT_FOUND of there being no token — leaves it untouched. */
    unsafe { CredReadW(&target, CRED_TYPE_GENERIC, None, &mut out) }.ok()?;
    if out.is_null() {
        return None;
    }
    /* SAFETY: `out` is non-null and points at a `CREDENTIALW` the API just
       wrote, whose blob is `CredentialBlobSize` bytes long. The copy is made
       before the free, and nothing borrows from the allocation afterwards. */
    let pat = unsafe {
        let cred = &*out;
        let bytes = if cred.CredentialBlob.is_null() {
            Vec::new()
        } else {
            std::slice::from_raw_parts(cred.CredentialBlob, cred.CredentialBlobSize as usize)
                .to_vec()
        };
        CredFree(out as *const _);
        String::from_utf8_lossy(&bytes).into_owned()
    };
    let pat = pat.trim().to_string();
    (!pat.is_empty()).then_some(pat)
}

#[cfg(windows)]
pub fn clear() -> Result<(), String> {
    clear_at(TARGET)
}

#[cfg(windows)]
pub fn clear_at(target: &str) -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::Win32::Security::Credentials::{CredDeleteW, CRED_TYPE_GENERIC};

    let wide = HSTRING::from(target);
    /* SAFETY: one null-terminated wide string that outlives the call. */
    match unsafe { CredDeleteW(&wide, CRED_TYPE_GENERIC, None) } {
        Ok(()) => Ok(()),
        /* Deleting a token that is not there is what the caller wanted to be
           true, so it is not an error. `held()` is the only honest way to tell
           the two apart and the front end asks that separately. */
        Err(_) if !held_at(target) => Ok(()),
        Err(e) => Err(format!("windows would not delete the token: {e}")),
    }
}

/// Whether a token is stored, without reading it out.
///
/// The distinction is the point: this is what the front end is told, so no code
/// path outside this module and the `Authorization` header ever holds the
/// secret. Same reason `snapshot.azdo` reports no fragment of a credential — a
/// snapshot is written to a file.
#[cfg(windows)]
pub fn held() -> bool {
    held_at(TARGET)
}

#[cfg(windows)]
pub fn held_at(target: &str) -> bool {
    read_at(target).is_some()
}

/* ── everywhere else ───────────────────────────────────────────────────────*/

#[cfg(not(windows))]
pub fn store(_pat: &str) -> Result<(), String> {
    Err("storing a token needs the Windows credential vault".into())
}

#[cfg(not(windows))]
pub fn read() -> Option<String> {
    None
}

#[cfg(not(windows))]
pub fn clear() -> Result<(), String> {
    Err("storing a token needs the Windows credential vault".into())
}

#[cfg(not(windows))]
pub fn held() -> bool {
    false
}

#[cfg(not(windows))]
pub fn store_at(_target: &str, _who: &str, _pat: &str) -> Result<(), String> {
    Err("storing a token needs the Windows credential vault".into())
}

#[cfg(not(windows))]
pub fn read_at(_target: &str) -> Option<String> {
    None
}

#[cfg(not(windows))]
pub fn clear_at(_target: &str) -> Result<(), String> {
    Err("storing a token needs the Windows credential vault".into())
}

#[cfg(not(windows))]
pub fn held_at(_target: &str) -> bool {
    false
}
