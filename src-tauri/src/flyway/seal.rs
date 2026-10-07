//! The key, the rooms it names, and the frames it seals.
//!
//! Everything a wall sends another wall goes through here, and nothing above
//! this file is allowed to assume the pipe is private. That is the whole design
//! constraint: the wire carries raw CLI events, which means tool results, which
//! means your source and whatever a tool happened to print. A relay that could
//! read a transcript would be a relay you could not use from an office network,
//! and a peer-to-peer path that could be observed is the same problem with
//! fewer hops. **So the transport is never trusted, and swapping it is not a
//! security decision.**
//!
//! ### One key, and it is the only configuration
//!
//! A wall knows one 32-byte secret, entered once per machine. Everything else
//! is derived from it:
//!
//! - **The room name** is `HMAC-SHA256(key, "…/room/v1" || scope)`, so a relay
//!   that has to route frames somewhere learns a hex string and not the name of
//!   the project you are working on. Two walls holding the same key compute the
//!   same room with nothing passing between them, which is what makes a key the
//!   only thing anybody has to type.
//! - **The content key** is HKDF over the same secret with a different label,
//!   so the value that names a room publicly and the value that decrypts its
//!   traffic are not the same bytes. A room id is quoted in logs and error
//!   messages by its nature; a content key must never be.
//!
//! ### What a frame does and does not promise
//!
//! `seal` gives confidentiality and integrity, and it **binds the frame to its
//! room** by passing the room id as associated data. A frame lifted out of one
//! room and replayed into another fails to open rather than decrypting into the
//! wrong conversation — which is the failure that would otherwise be silent.
//!
//! It does **not** sign, and that is a decision rather than an omission.
//! Holding the key is already the whole of membership: a card spawned over the
//! flyway runs with `--dangerously-skip-permissions`, so anybody who can seal a
//! frame can already run code on every machine in it. A per-frame signature
//! would defend against an insider who is by construction fully trusted, and
//! against an outsider who cannot produce a frame at all. The honest reading is
//! that **attribution here is a label among parties who trust each other**, so
//! the sending host's name travels *inside* the sealed payload and is believed.
//! If the flyway ever gains a member who is not trusted with the machine, this
//! paragraph is the one that stops being true, and signing is the answer.
//!
//! ### Nonces
//!
//! Random, 96-bit, fresh per frame. ChaCha20-Poly1305 wants a nonce never
//! reused under one key, and the two ways to get that are a counter or enough
//! random bits. A counter is the stronger answer for a single long-lived
//! stream and the *wrong* answer here: frames are produced independently by
//! several machines that cannot see each other's counters, so a shared counter
//! is a synchronisation problem invented to avoid a birthday bound. With random
//! 96-bit nonces the collision probability stays under 2⁻³² until roughly 2³²
//! frames on one key — a sink item is one frame, so that is a bound nothing
//! here can approach, and rotating the key resets it.

use ring::aead::{self, Aad, BoundKey, Nonce, NonceSequence, UnboundKey};
use ring::rand::{SecureRandom, SystemRandom};
use ring::{hkdf, hmac};

/// Bumped if the frame layout or the derivation labels ever change. A frame
/// from a build that disagrees is refused by its first byte rather than
/// failing later as a corrupt payload, which is the difference between "update
/// the other machine" and "something is wrong with the wire".
const FRAME_VERSION: u8 = 1;

const NONCE_LEN: usize = 12;
/// ChaCha20-Poly1305's tag. Stated rather than inferred so the length checks
/// below read as arithmetic instead of as magic numbers.
const TAG_LEN: usize = 16;

/// Domain separation. Every derived value names what it is for, so a value
/// derived for one purpose can never be mistaken for another — the standard
/// reason, and here also a practical one: the room id is public by nature and
/// the content key must never be.
const ROOM_LABEL: &str = "volery/flyway/room/v1";
const CONTENT_SALT: &[u8] = b"volery/flyway/v1";
const CONTENT_INFO: &[u8] = b"content";

/// The secret a wall is a member by.
///
/// Derives nothing, deliberately — in particular not `Debug` or `Clone`. A
/// secret with a `Debug` impl is one `{:?}` in a log line away from being
/// written to disk, and this app has four log faces that would happily draw it.
/// Everything above takes it by reference for the same reason the `Drop` below
/// exists: the fewer copies there are, the more the wipe is worth.
pub struct WallKey([u8; 32]);

impl WallKey {
    /// A fresh key from the system CSPRNG.
    ///
    /// Generated rather than typed, always. A key somebody invents is a key
    /// with a person's entropy in it, and this one is a credential that is
    /// remote code execution on every machine it has been entered on.
    pub fn generate() -> Result<Self, String> {
        let mut raw = [0u8; 32];
        SystemRandom::new()
            .fill(&mut raw)
            .map_err(|_| "the system random source refused".to_string())?;
        Ok(Self(raw))
    }

    pub fn from_bytes(raw: [u8; 32]) -> Self {
        Self(raw)
    }

    /// The key as something a person can carry to another machine.
    ///
    /// Crockford base32, in groups of four. Crockford rather than RFC 4648
    /// because its alphabet leaves out `I`, `L`, `O` and `U` — the characters
    /// that get read back wrong off a screen — and because it decodes
    /// case-insensitively and treats `0`/`O` and `1`/`I`/`L` as the same
    /// character, so the three mistakes a person actually makes are not
    /// mistakes. The groups are for the eye only and are ignored on the way
    /// back in.
    pub fn phrase(&self) -> String {
        let raw = base32_encode(&self.0);
        raw.as_bytes()
            .chunks(4)
            .map(|c| std::str::from_utf8(c).unwrap_or("").to_string())
            .collect::<Vec<_>>()
            .join("-")
    }

    /// Read a key back off a phrase, forgiving everything that is not a
    /// character: spaces, dashes, case, and the ambiguous pairs.
    pub fn from_phrase(phrase: &str) -> Result<Self, String> {
        let raw = base32_decode(phrase)?;
        if raw.len() != 32 {
            return Err(format!(
                "a wall key is 32 bytes and that phrase carries {} — check it was copied whole",
                raw.len()
            ));
        }
        let mut out = [0u8; 32];
        out.copy_from_slice(&raw);
        Ok(Self(out))
    }

    /// What this key calls a room, for a relay to route by and learn nothing
    /// from. `scope` is the thing being shared — a project's identity, or the
    /// wall itself.
    pub fn room(&self, scope: &str) -> String {
        let k = hmac::Key::new(hmac::HMAC_SHA256, &self.0);
        let mut m = Vec::with_capacity(ROOM_LABEL.len() + scope.len());
        m.extend_from_slice(ROOM_LABEL.as_bytes());
        m.extend_from_slice(scope.as_bytes());
        let tag = hmac::sign(&k, &m);
        tag.as_ref()[..16].iter().map(|b| format!("{b:02x}")).collect()
    }

    fn content_key(&self) -> Result<[u8; 32], String> {
        let prk = hkdf::Salt::new(hkdf::HKDF_SHA256, CONTENT_SALT).extract(&self.0);
        let okm = prk
            .expand(&[CONTENT_INFO], hkdf::HKDF_SHA256)
            .map_err(|_| "could not derive the content key".to_string())?;
        let mut out = [0u8; 32];
        okm.fill(&mut out)
            .map_err(|_| "could not derive the content key".to_string())?;
        Ok(out)
    }

    /// Seal a payload for one room.
    ///
    /// The room id is the associated data, which is what stops a frame being
    /// lifted into another room and opened there. It is authenticated, not
    /// encrypted — a relay needs to read it to route at all, and it is derived
    /// precisely so that reading it tells nobody anything.
    pub fn seal(&self, room: &str, plaintext: &[u8]) -> Result<Vec<u8>, String> {
        let mut nonce = [0u8; NONCE_LEN];
        SystemRandom::new()
            .fill(&mut nonce)
            .map_err(|_| "the system random source refused".to_string())?;

        let unbound = UnboundKey::new(&aead::CHACHA20_POLY1305, &self.content_key()?)
            .map_err(|_| "could not build the frame key".to_string())?;
        let mut key = aead::SealingKey::new(unbound, Once(Some(nonce)));

        let mut body = plaintext.to_vec();
        key.seal_in_place_append_tag(Aad::from(room.as_bytes()), &mut body)
            .map_err(|_| "could not seal the frame".to_string())?;

        let mut out = Vec::with_capacity(1 + NONCE_LEN + body.len());
        out.push(FRAME_VERSION);
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&body);
        Ok(out)
    }

    /// Open a frame that claims to be for one room.
    ///
    /// Every failure is one message on purpose. Telling the caller *why* a
    /// frame did not open — wrong key, wrong room, truncated, tampered — is
    /// telling whoever sent it which of those to try next, and none of the four
    /// is a thing an honest sender needs to be told apart.
    pub fn open(&self, room: &str, frame: &[u8]) -> Result<Vec<u8>, String> {
        if frame.first() != Some(&FRAME_VERSION) {
            return Err(match frame.first() {
                Some(v) => format!(
                    "that frame is flyway v{v} and this wall speaks v{FRAME_VERSION} — one of the two needs updating"
                ),
                None => "an empty frame".to_string(),
            });
        }
        /* At least a nonce and a tag, or the slicing below would panic on a
           frame somebody truncated. A length check is the one thing here that
           has to come before the cryptography rather than after it. */
        if frame.len() < 1 + NONCE_LEN + TAG_LEN {
            return Err("that frame did not open".to_string());
        }

        let mut nonce = [0u8; NONCE_LEN];
        nonce.copy_from_slice(&frame[1..1 + NONCE_LEN]);

        let unbound = UnboundKey::new(&aead::CHACHA20_POLY1305, &self.content_key()?)
            .map_err(|_| "could not build the frame key".to_string())?;
        let mut key = aead::OpeningKey::new(unbound, Once(Some(nonce)));

        let mut body = frame[1 + NONCE_LEN..].to_vec();
        let opened = key
            .open_in_place(Aad::from(room.as_bytes()), &mut body)
            .map_err(|_| "that frame did not open".to_string())?;
        Ok(opened.to_vec())
    }
}

/// Overwrite the secret when it goes out of scope.
///
/// `write_volatile` so the compiler may not elide it as a write nobody reads.
/// This is worth doing and worth not overstating: it does not reach a copy the
/// allocator moved, nor one the OS paged out, and `WallKey` is passed by
/// reference everywhere above precisely to keep the number of copies at one.
impl Drop for WallKey {
    fn drop(&mut self) {
        for b in self.0.iter_mut() {
            unsafe { std::ptr::write_volatile(b, 0) };
        }
    }
}

/// A nonce sequence that yields exactly one nonce.
///
/// `ring` models nonce reuse out of the API by handing you a sequence rather
/// than a value, which is the right shape for a stream and an awkward one for
/// independent frames. Yielding one and then refusing is that constraint kept
/// rather than worked around: a second call is a bug, and it fails here instead
/// of encrypting two frames under one nonce.
struct Once(Option<[u8; NONCE_LEN]>);

impl NonceSequence for Once {
    fn advance(&mut self) -> Result<Nonce, ring::error::Unspecified> {
        self.0.take().map(Nonce::assume_unique_for_key).ok_or(ring::error::Unspecified)
    }
}

/* ── Crockford base32 ─────────────────────────────────────────────────────────

   Written out rather than taken as a dependency: it is thirty lines, the
   alphabet is the whole of the decision, and a crate for it would be a supply
   chain for something a test can read end to end. */

const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

fn base32_encode(raw: &[u8]) -> String {
    let mut out = String::new();
    let (mut acc, mut bits) = (0u32, 0u32);
    for &b in raw {
        acc = (acc << 8) | b as u32;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(ALPHABET[((acc >> bits) & 31) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(ALPHABET[((acc << (5 - bits)) & 31) as usize] as char);
    }
    out
}

fn base32_decode(phrase: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let (mut acc, mut bits) = (0u32, 0u32);
    for ch in phrase.chars() {
        /* The separators the eye needs and the key does not. */
        if ch == '-' || ch.is_whitespace() {
            continue;
        }
        let v = match ch.to_ascii_uppercase() {
            /* Crockford's three confusions, each folded onto the digit a
               person meant. This is the whole reason the alphabet was chosen. */
            'O' => 0,
            'I' | 'L' => 1,
            c => match ALPHABET.iter().position(|&a| a == c as u8) {
                Some(i) => i as u32,
                None => return Err(format!("{ch:?} is not part of a wall key")),
            },
        };
        acc = (acc << 5) | v;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 0xff) as u8);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> WallKey {
        WallKey::from_bytes([7u8; 32])
    }

    #[test]
    fn a_payload_comes_back_exactly_as_it_went_in() {
        let k = key();
        let room = k.room("skein");
        let frame = k.seal(&room, b"a sink item").unwrap();
        assert_eq!(k.open(&room, &frame).unwrap(), b"a sink item");
    }

    /// The one failure that would otherwise be silent: a frame decrypting into
    /// the wrong conversation rather than refusing.
    #[test]
    fn a_frame_lifted_into_another_room_does_not_open() {
        let k = key();
        let here = k.room("skein");
        let there = k.room("nova");
        assert_ne!(here, there);
        let frame = k.seal(&here, b"private").unwrap();
        assert!(k.open(&there, &frame).is_err());
    }

    #[test]
    fn another_key_opens_nothing() {
        let mine = key();
        let theirs = WallKey::from_bytes([9u8; 32]);
        let room = mine.room("skein");
        let frame = mine.seal(&room, b"private").unwrap();
        /* Not even the room name is shared, but ask with the right one anyway —
           the key alone has to be enough to fail on. */
        assert!(theirs.open(&room, &frame).is_err());
        assert_ne!(theirs.room("skein"), room);
    }

    #[test]
    fn one_flipped_byte_anywhere_is_refused() {
        let k = key();
        let room = k.room("skein");
        let frame = k.seal(&room, b"a sink item worth tampering with").unwrap();
        /* Every byte past the version: the nonce, the ciphertext and the tag.
           A guard that only checked the body would pass a nonce rewritten in
           flight, which is the cheapest thing for a pipe to do to a frame. */
        for i in 1..frame.len() {
            let mut bent = frame.clone();
            bent[i] ^= 1;
            assert!(k.open(&room, &bent).is_err(), "byte {i} was not protected");
        }
    }

    #[test]
    fn a_truncated_frame_is_refused_rather_than_panicking() {
        let k = key();
        let room = k.room("skein");
        let frame = k.seal(&room, b"x").unwrap();
        for n in 0..frame.len() {
            assert!(k.open(&room, &frame[..n]).is_err());
        }
    }

    #[test]
    fn a_frame_from_another_version_says_which_end_is_old() {
        let k = key();
        let room = k.room("skein");
        let mut frame = k.seal(&room, b"x").unwrap();
        frame[0] = 99;
        let why = k.open(&room, &frame).unwrap_err();
        assert!(why.contains("v99"), "{why}");
        assert!(why.contains("updating"), "{why}");
    }

    /// Two seals of one payload must not be the same bytes, or the wire leaks
    /// that a message repeated — which for a sink being synced is most of what
    /// there is to leak.
    #[test]
    fn the_same_payload_seals_differently_every_time() {
        let k = key();
        let room = k.room("skein");
        let a = k.seal(&room, b"same").unwrap();
        let b = k.seal(&room, b"same").unwrap();
        assert_ne!(a, b);
        assert_eq!(k.open(&room, &a).unwrap(), k.open(&room, &b).unwrap());
    }

    #[test]
    fn a_room_is_stable_for_one_key_and_different_for_another() {
        let a = WallKey::from_bytes([1u8; 32]);
        let b = WallKey::from_bytes([2u8; 32]);
        assert_eq!(a.room("skein"), a.room("skein"));
        assert_ne!(a.room("skein"), b.room("skein"));
        assert_ne!(a.room("skein"), a.room("skein2"));
        /* And it says nothing about the scope it came from. */
        assert!(!a.room("skein").contains("skein"));
        assert_eq!(a.room("skein").len(), 32);
    }

    /// The room id is public by nature — a relay routes by it. It must not be
    /// the thing that decrypts the traffic.
    #[test]
    fn the_room_name_is_not_the_content_key() {
        let k = key();
        assert_ne!(k.room("skein").as_bytes(), &k.content_key().unwrap()[..]);
    }

    #[test]
    fn a_phrase_carries_the_key_to_another_machine() {
        let k = WallKey::generate().unwrap();
        let said = k.phrase();
        let back = WallKey::from_phrase(&said).unwrap();
        assert_eq!(back.room("skein"), k.room("skein"));
    }

    /// The three mistakes a person makes reading a key off a screen, and the
    /// whole reason the alphabet is Crockford's.
    #[test]
    fn the_confusable_characters_are_forgiven() {
        let k = WallKey::from_bytes([0u8; 32]);
        let said = k.phrase();
        let typed = said
            .to_lowercase()
            .replace('-', " ")
            .replace('0', "O")
            .replace('1', "l");
        let back = WallKey::from_phrase(&typed).unwrap();
        assert_eq!(back.room("x"), k.room("x"));
    }

    #[test]
    fn a_phrase_that_is_not_one_is_refused_with_a_reason() {
        assert!(WallKey::from_phrase("").is_err());
        assert!(WallKey::from_phrase("ABCD-EFGH").is_err());
        /* `.err().unwrap()` rather than `.unwrap_err()`, which would want
           `Debug` on `WallKey` — and a secret with a `Debug` impl is a secret
           one `dbg!` or one `{:?}` in a log line away from being written down.
           That is why the struct derives nothing. */
        let why = WallKey::from_phrase("ABCD-EF!H").err().unwrap();
        assert!(why.contains("not part of a wall key"), "{why}");
    }

    #[test]
    fn a_generated_key_is_not_a_constant() {
        let a = WallKey::generate().unwrap();
        let b = WallKey::generate().unwrap();
        assert_ne!(a.phrase(), b.phrase());
        /* 32 bytes at 5 bits a character, grouped in fours. */
        assert_eq!(a.phrase().replace('-', "").len(), 52);
    }
}
