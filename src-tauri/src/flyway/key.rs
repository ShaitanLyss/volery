//! Where the wall key lives, and what this machine calls itself.
//!
//! The key goes in the Windows credential vault beside the other four secrets
//! this app keeps, for the reasons `vault.rs` sets out at length — not the
//! SQLite file, which `portage.rs` exports whole, and not a DPAPI blob of our
//! own, which would be a credential you cannot find or revoke without the
//! cooperation of the thing holding it.
//!
//! **`dev.skein.studio/flyway-key` is not renameable**, the same promise
//! `azdo-pat` and `asana-pat` carry and for the same reason: it keys off the
//! durable identity rather than the visible one, so a further rename does not
//! read as the app having forgotten your key. See CLAUDE.md on where the
//! Skein → Volery rename deliberately stopped.
//!
//! ### Entering it here is the membership decision
//!
//! There is no second gate on this, and that is settled rather than skipped. A
//! card spawned over the flyway runs with `--dangerously-skip-permissions`, and
//! a card can `cd` anywhere — so scoping which *folders* a remote spawn may
//! reach buys a feeling rather than a property. What is a real boundary is
//! whether anything on this machine will answer at all, and that is decided by
//! whether a human sat at this machine and put the key in this vault. **No
//! machine can be conscripted by a key alone.** What stands in for a gate is a
//! brake and a witness: the per-roost spawn bounds `spawn.rs` already keeps, a
//! chronicle row naming the originating host for every remotely-born card, and
//! leaving the flyway as a gesture that kills them.

use super::seal::WallKey;

/// The vault target. Not renameable — see the note above.
const TARGET: &str = "dev.skein.studio/flyway-key";

/// What the credential is listed as in Control Panel, where somebody looking
/// for "what has this app got of mine" will read it.
const WHO: &str = "volery flyway";

/// What separates the key from the machine name in a stored invite.
///
/// Not a character the phrase alphabet contains, so splitting can never cut a
/// key in half — Crockford base32 is digits and consonants, and this is
/// neither.
const SPLIT: char = '·';

/// The key this wall is a member by, or `None` if it has never been given one.
///
/// Every failure is `None`: a vault that cannot be read and a wall that has
/// never joined a flyway are the same thing from here — not a member — and the
/// one path that genuinely needs to tell them apart is the panel, which asks
/// `held` instead.
pub fn wall_key() -> Option<WallKey> {
    let held = crate::vault::read_at(TARGET)?;
    WallKey::from_phrase(held.split(SPLIT).next()?).ok()
}

/// The machine named by the invite this wall joined with, if it was somebody
/// else's.
///
/// **This is the whole of the bootstrap**, and it is why an invite carries a
/// name at all: dialling needs a peer's identity, the identity is derived from
/// the key and the machine's name, so one name is enough to find one wall — and
/// every other wall on the flyway is learned from that one.
///
/// A wall that *started* its flyway has its own name stored here, which is not
/// a peer. Filtered rather than special-cased at the call site, because the one
/// thing worse than not dialling anybody is a wall dialling itself and
/// deadlocking against its own accept loop.
pub fn joined_peer() -> Option<String> {
    let held = crate::vault::read_at(TARGET)?;
    let host = held.split(SPLIT).nth(1)?.trim().to_string();
    if host.is_empty() || host.eq_ignore_ascii_case(&host_name()) {
        return None;
    }
    Some(host)
}

/// Whether this wall has a key at all, without reading it.
pub fn held() -> bool {
    crate::vault::held_at(TARGET)
}

/// Join a flyway with a key from another machine.
///
/// Parsed before it is stored, so a phrase that was copied short is refused at
/// the door with a reason rather than stored and found to be wrong later — at
/// which point the symptom is "the other wall cannot see me" and the cause is
/// four layers down.
pub fn join(invite: &str) -> Result<(), String> {
    let mut parts = invite.splitn(2, SPLIT);
    let phrase = parts.next().unwrap_or("");
    let peer = parts.next().map(str::trim).unwrap_or("");
    let key = WallKey::from_phrase(phrase)?;
    if peer.is_empty() {
        return Err(
            "that invite names no machine, so there is nobody to dial — copy the whole of it, \
             including the part after the dot"
                .to_string(),
        );
    }
    /* Stored in its canonical spelling rather than as typed, so the vault never
       holds one person's spacing and another's case. `phrase()` is the round
       trip `seal.rs` tests. */
    crate::vault::store_at(TARGET, WHO, &format!("{}{SPLIT}{}", key.phrase(), peer))
}

/// Start a flyway: a fresh key, stored, and handed back **once** so it can be
/// shown to the person who asked for it.
///
/// Returned rather than readable-on-demand because a secret the UI can ask for
/// at any time is a secret on screen at times nobody chose. Getting it onto the
/// second machine is a thing you do now; afterwards the panel says only that a
/// key is held.
pub fn start() -> Result<String, String> {
    let key = WallKey::generate()?;
    /* The invite is the key **and this machine's name**, because the other wall
       has to be able to find this one and an identity is derived from the two
       together (`WallKey::node_secret`). The alternative was a 52-character
       node id in the invite or a rendezvous server; a name is the thing a
       person can already read. */
    let invite = format!("{}{SPLIT}{}", key.phrase(), host_name());
    crate::vault::store_at(TARGET, WHO, &invite)?;
    Ok(invite)
}

/// Leave the flyway. The key goes; what it reached does not follow by itself,
/// which is why the caller is expected to close what was born over it.
pub fn leave() -> Result<(), String> {
    crate::vault::clear_at(TARGET)
}

/// What this machine calls itself, for the `origin_host` on anything it writes.
///
/// `COMPUTERNAME` on Windows, `HOSTNAME` elsewhere, and a plain fallback rather
/// than an error: a sink item whose origin reads `this machine` is a sink item
/// with a slightly useless label, where refusing to write one over a missing
/// environment variable would be losing the finding itself.
///
/// Deliberately **not** an identity. It is what a person reads in a listing to
/// think "that was the laptop", and two machines with one name are a thing they
/// can see and rename. Anything that needs to tell two walls apart needs an id,
/// and the sink does not — see `sink.rs` on why origin is attribution.
pub fn host_name() -> String {
    /* An override, so two walls can exist on one machine.
    
       Not a convenience: a wall's identity is derived from the key *and* this
       name, so without it every test of the link is two endpoints with one
       identity, which is a wall dialling itself and is the one arrangement that
       cannot work. `examples/flyway-link.rs` is the whole reason it exists, and
       it is the only honest way to exercise the real store path before two
       machines are in the room. Named for the product rather than the crate,
       like `VOLERY_AZDO_PAT`. */
    if let Ok(v) = std::env::var("VOLERY_FLYWAY_HOST") {
        let v = v.trim();
        if !v.is_empty() {
            return crate::clip::keep(v, 40).kept;
        }
    }
    for var in ["COMPUTERNAME", "HOSTNAME"] {
        if let Ok(v) = std::env::var(var) {
            let v = v.trim();
            if !v.is_empty() {
                return crate::clip::keep(v, 40).kept;
            }
        }
    }
    "this machine".to_string()
}

/* ── the commands ─────────────────────────────────────────────────────────── */

/// Whether this wall is in a flyway. The only thing the panel may ask.
#[tauri::command]
pub fn flyway_held() -> bool {
    held()
}

#[tauri::command]
pub async fn flyway_start() -> Result<String, String> {
    crate::off_main(start).await?
}

#[tauri::command]
pub async fn flyway_join(phrase: String) -> Result<(), String> {
    crate::off_main(move || join(&phrase)).await?
}

#[tauri::command]
pub async fn flyway_leave() -> Result<(), String> {
    crate::off_main(leave).await?
}

/// What this machine calls itself, so the sink can say where a finding came
/// from without every caller reading an environment variable.
#[tauri::command]
pub fn flyway_host() -> String {
    host_name()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The target is a string the disk depends on. A rename orphans every key
    /// already entered on every machine, and the symptom is the app silently
    /// not being in a flyway any more — which reads as a bug in the wire.
    #[test]
    fn the_vault_target_keeps_the_durable_identity() {
        assert_eq!(TARGET, "dev.skein.studio/flyway-key");
        assert!(TARGET.starts_with("dev.skein.studio/"));
    }

    #[test]
    fn a_machine_always_has_something_to_be_called() {
        let n = host_name();
        assert!(!n.is_empty());
        assert!(n.len() <= 40, "{n}");
    }
}
