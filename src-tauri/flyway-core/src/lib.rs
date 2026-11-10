//! The flyway's pure core: the key and the frames it seals, the vocabularies
//! two walls speak, how their piles converge, and the iroh transport that
//! carries them — with nothing of the app in it. No Tauri, no store, no front
//! end, no process.
//!
//! `src-tauri` re-exports every module here under its old path
//! (`crate::flyway::seal`, `crate::clean`, `crate::cast::wire` and the rest),
//! so the desktop is byte-for-byte the wall it was; `src-tauri/src/flyway/mod.rs`
//! has the map of the whole flyway, this half and the wiring together. A phone
//! links this crate to be a node on the flyway itself (`docs/PHONE.md`, M1).
//!
//! **The line is drawn by dependency, not by file.** What reads this machine —
//! the disk half of `seeing`, a parcel's caps and name rules, which services a
//! card may be moved onto — stays in the app, and where a type here needed one
//! of those it takes it as an argument (`act::read_args_with`) or the app
//! hangs it on with a trait of its own (`parcel::CarriedHere`).
//!
//! Helpers that came along because the wire needs them, not because they are
//! about the flyway: `clean` and `clip` (every text an agent will read passes
//! through them), `base64`, `ask`'s walk over a question's files, and the
//! `screen` and `parcel` wire types.

pub mod accounts;
pub mod act;
pub mod ask;
pub mod boards;
pub mod cards;
pub mod cast;
pub mod clean;
pub mod clip;
pub mod directory;
pub mod fleet;
pub mod frame;
pub mod look;
pub mod moving;
pub mod parcel;
pub mod screen;
pub mod seal;
pub mod seeing;
pub mod session;
pub mod steward;
pub mod sync;
pub mod tail;
pub mod wire;

/// Base64, written out rather than pulled in.
///
/// Eleven lines against a dependency in the tree of an app that is careful about
/// its tree, which is the same bargain `azdo.rs` struck when it wrote this — and
/// `base64` is already in `Cargo.lock` twice as a transitive of librespot, so
/// adding it directly would pin a third version of eleven lines.
///
/// Here rather than in either caller because there are two now, in modules with
/// nothing to do with each other: `azdo::Cred` builds a `Basic` header, and
/// `find::read_media` puts a project's image on a `data:` URL for the viewer. A
/// general utility living in a service file is fine until the second caller and
/// misleading afterwards.
///
/// Standard alphabet with padding — no URL-safe variant, because neither caller
/// wants one and an encoder that guesses which is being asked for is worse than
/// two functions. `base64_pads_the_way_everything_else_does` is the guard, and
/// the padding is the half worth having a test for: a `Basic` header short by an
/// `=` is a 401 that looks like a wrong password.
pub fn base64(bytes: &[u8]) -> String {
    const SET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(SET[((n >> (18 - i * 6)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// Standard base64 back to bytes (padding optional), or `None` on any foreign
/// character. Written for `relay.rs`'s narration signatures and moved here the
/// day the flyway's `look` needed it too, for `base64`'s own reason.
pub fn unbase64(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in s.trim_end_matches('=').bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

#[cfg(test)]
mod base64_tests {
    use super::{base64, unbase64};

    #[test]
    fn unbase64_undoes_base64() {
        for s in [&b""[..], b"f", b"fo", b"foo", b"foob", b"fooba", b"foobar", &[0u8, 255, 128, 7][..]] {
            assert_eq!(unbase64(&base64(s)).as_deref(), Some(s));
        }
        assert_eq!(unbase64("Zm9v!"), None);
    }

    /// Came here with the function it tests. The padding is the part that
    /// matters: a `Basic` header short by an `=` is a 401 that reads as a wrong
    /// password, and a `data:` URL short by one is an image that does not decode.
    #[test]
    fn base64_pads_the_way_everything_else_does() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }
}
