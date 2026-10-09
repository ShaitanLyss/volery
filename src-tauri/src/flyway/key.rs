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

/// A lab's key lives under its *own* identifier — `dev.skein.lab.<name>/flyway-key` —
/// the way its store, its browser profile and `claim_wall`'s mutex already do.
///
/// Every wall on one machine reads one vault, so a lab used to join the *real*
/// flyway on the installed wall's key: every lab host it was ever run as became
/// a row on the roster of every machine in it, and its cards drew as shadows on
/// Lyss's wall. By 2026-10-09 her roster carried `lab`, `lab2`, `lab-a`, `lab-b`,
/// `mva` and `mvb` beside her two real machines. The key *is* the membership
/// boundary (`seal.rs`: holding it is full trust), so the fix is a key of the
/// lab's own and nothing else — no filtering of what is drawn, which would leave
/// a lab really on her flyway, able to spawn into it and sync her sink.
///
/// **Do not "share" this target back with the studio's to save a step.** Being
/// separate is also what makes a lab unable to clear her key: `leave` wipes
/// whatever `target()` names, and here that is the lab's own entry.
static OWN_TARGET: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// Set when a lab was launched onto the *installed wall's* key on purpose
/// (`bun run lab <name> --join-installed-wall-flyway`). It may then read that
/// key and fly on it, and may never write or clear it: that entry is a person's.
static BORROWED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Keep this process's flyway to a key under its own identifier. Called once,
/// before the builder, by `lab::assume`; a process does not stop being a lab.
pub fn keep_to(identifier: &str) {
    let _ = OWN_TARGET.set(lab_target(identifier));
}

/// Fly on the installed wall's key without being able to change it.
pub fn borrow_the_installed_key() {
    BORROWED.store(true, std::sync::atomic::Ordering::Relaxed);
}

fn lab_target(identifier: &str) -> String {
    format!("{identifier}/flyway-key")
}

fn target() -> &'static str {
    OWN_TARGET.get().map(String::as_str).unwrap_or(TARGET)
}

/// What the credential is listed as, so a lab's key is never mistaken for the
/// real one by somebody reading Control Panel.
fn who() -> &'static str {
    if OWN_TARGET.get().is_some() {
        "volery lab flyway"
    } else {
        WHO
    }
}

/// Refuse a write to the installed wall's key from a lab borrowing it.
fn may_write() -> Result<(), String> {
    refuse_if_borrowed(BORROWED.load(std::sync::atomic::Ordering::Relaxed))
}

fn refuse_if_borrowed(borrowed: bool) -> Result<(), String> {
    if borrowed {
        return Err("this lab is flying on the installed wall's key, which it may use and \
                    never change — start, join or leave a flyway from the installed wall"
            .to_string());
    }
    Ok(())
}

/// A lab coming up for the first time: take the key of the lab named by
/// `peer`, if it has one, or mint a fresh one, so `bun run lab b --peer a` is
/// two walls on one flyway with nobody pasting an invite. Only another lab's
/// entry can be read here — never the studio's, which is the whole of
/// `lab_target` refusing anything but `dev.skein.lab.*`.
pub fn settle_lab(peer: Option<&str>) -> Result<(), String> {
    let Some(own) = OWN_TARGET.get() else { return Ok(()) };
    if crate::vault::held_at(own) {
        return Ok(());
    }
    if let Some(peer) = peer {
        if !peer.starts_with("dev.skein.lab.") {
            return Err(format!("{peer} is not a lab, so its key is not a lab's to copy"));
        }
        let invite = crate::vault::read_at(&lab_target(peer))
            .ok_or_else(|| format!("{peer} holds no flyway key yet — bring it up first"))?;
        return crate::vault::store_at(own, who(), &invite);
    }
    start().map(|_| ())
}

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
    let held = crate::vault::read_at(target())?;
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
    /* Who to dial first, overridden — test plumbing in the shape of
       `VOLERY_FLYWAY_HOST` below, and for the same reason. Every wall on one
       machine reads one vault, so they all hold one invite naming one seed;
       a second lab wall that should find the first by name has no other way to
       be told it. Never set on a real machine, where the invite is the seed. */
    if let Ok(v) = std::env::var("VOLERY_FLYWAY_PEER") {
        let v = v.trim();
        if !v.is_empty() && !v.eq_ignore_ascii_case(&host_name()) {
            return Some(crate::clip::keep(v, 40).kept);
        }
    }
    let held = crate::vault::read_at(target())?;
    let host = held.split(SPLIT).nth(1)?.trim().to_string();
    if host.is_empty() || host.eq_ignore_ascii_case(&host_name()) {
        return None;
    }
    Some(host)
}

/// Whether this wall has a key at all, without reading it.
pub fn held() -> bool {
    crate::vault::held_at(target())
}

/// Join a flyway with a key from another machine.
///
/// Parsed before it is stored, so a phrase that was copied short is refused at
/// the door with a reason rather than stored and found to be wrong later — at
/// which point the symptom is "the other wall cannot see me" and the cause is
/// four layers down.
pub fn join(invite: &str) -> Result<(), String> {
    may_write()?;
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
    crate::vault::store_at(target(), who(), &format!("{}{SPLIT}{}", key.phrase(), peer))
}

/// Start a flyway: a fresh key, stored, and handed back so it can be shown to
/// the person who asked for it. See `invite` for reading it back afterwards.
pub fn start() -> Result<String, String> {
    may_write()?;
    let key = WallKey::generate()?;
    /* The invite is the key **and this machine's name**, because the other wall
       has to be able to find this one and an identity is derived from the two
       together (`WallKey::node_secret`). The alternative was a 52-character
       node id in the invite or a rendezvous server; a name is the thing a
       person can already read. */
    let invite = format!("{}{SPLIT}{}", key.phrase(), host_name());
    crate::vault::store_at(target(), who(), &invite)?;
    Ok(invite)
}

/// The invite this wall was started with, read back out of the vault.
///
/// **This was deliberately not here, and the reasoning was right about the
/// hazard and wrong about the work.** The argument was that a secret the UI can
/// ask for at any time is a secret on screen at times nobody chose, so `start`
/// handed its invite back once and the panel afterwards said only that a key is
/// held. What that missed is *when* the second machine arrives: a flyway is
/// started on the machine you are at and joined from the machine you are at
/// tomorrow, so the one moment the invite is shown is a moment you are not yet
/// standing in front of the wall that needs it. Lose the clipboard — close the
/// panel, reboot, come back a day later — and the only gesture left is `start`,
/// which mints a *fresh* key and silently orphans every wall already holding
/// the old one. An unreadable secret whose only recovery is destroying it is
/// not a safe secret, it is a trap with good manners.
///
/// So the hazard is answered where it actually lives, which is the drawing
/// rather than the reading: the panel keeps it hidden and reveals on a press,
/// and forgets it when the panel closes. A press is a time somebody chose.
///
/// Nothing is derived or re-minted here — the vault holds the invite in its
/// canonical spelling (`start` and `join` both store it that way), so this is
/// the same string, not a second opinion about what it was.
pub fn invite() -> Option<String> {
    crate::vault::read_at(target())
}

/// Leave the flyway. The key goes; what it reached does not follow by itself,
/// which is why the caller is expected to close what was born over it.
pub fn leave() -> Result<(), String> {
    may_write()?;
    crate::vault::clear_at(target())
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

/// The invite again, for getting it onto a machine that is not in front of you
/// yet. Refused rather than answered empty when there is nothing to show, so a
/// panel cannot draw a reveal over nothing.
#[tauri::command]
pub async fn flyway_invite() -> Result<String, String> {
    crate::off_main(|| invite().ok_or_else(|| "this wall is not in a flyway".to_string())).await?
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

    /// A lab's key is a different credential, so nothing a lab stores or
    /// clears can reach the installed wall's membership.
    #[test]
    fn a_lab_keeps_its_key_under_its_own_identifier() {
        assert_eq!(lab_target("dev.skein.lab.a"), "dev.skein.lab.a/flyway-key");
        assert_ne!(lab_target("dev.skein.lab.a"), lab_target("dev.skein.lab.b"));
        assert_ne!(lab_target("dev.skein.lab"), TARGET);
        assert_eq!(target(), TARGET, "a process is the studio's until told otherwise");
    }

    /// A lab flying on the installed wall's key may not start, join or leave
    /// on it — `leave` would clear a person's membership from under them.
    #[test]
    fn a_borrowed_key_cannot_be_changed() {
        assert!(refuse_if_borrowed(true).is_err());
        assert!(refuse_if_borrowed(false).is_ok());
    }

    #[test]
    fn a_machine_always_has_something_to_be_called() {
        let n = host_name();
        assert!(!n.is_empty());
        assert!(n.len() <= 40, "{n}");
    }
}
