//! The flyway: the wire between one person's walls.
//!
//! A volery is the enclosure; a flyway is the route between them. This is the
//! route — what lets a project exist on several machines at once, with cards
//! hosted wherever the repo, the toolchain and the credentials actually are.
//!
//! Bottom to top, and each file's own comment is its design:
//!
//! - `seal` — the key, the rooms it names, and the frames it seals. Everything
//!   above it may assume the pipe is hostile, which is what makes the choice of
//!   transport an engineering decision rather than a security one.
//! - `key` — the key's home in the credential vault, the invite, `host_name`.
//! - `sync`, `session` — how two sinks converge, and what two walls say about
//!   one. Pure.
//! - `fleet` — the roster, and asking another wall to open a card. Pure.
//! - `cards` — what each wall's cards look like, carried and never read. Pure.
//! - `boards` — what each wall's billboard says, held by the others, and a
//!   notice taken down from another wall. Pure; `link/boards.rs` is the wiring.
//! - `accounts` — every wall's account settings kept in step (a register per
//!   field, last write wins on a hybrid clock), the readings shared by age, and
//!   the digests that find a sign-in copied between machines. Pure;
//!   `link/accounting.rs` is the wiring and `accountsync.rs` the store.
//! - `tail` — one card's conversation, pulled by a wall with a panel open on
//!   it and answered in the same exchange. Pure.
//! - `look` — what a question asked on another wall shows: its arguments and
//!   its files' bytes, pulled in parts by the wall a person is at. Pure.
//! - `act` — a person's gesture on another wall's card, every verb in one
//!   frame, answered in the same exchange and gated by what it costs. Pure.
//! - `moving` — a card changing wall: the vocabulary, the check that it
//!   still has its history, and the rule that it never ends up on neither.
//!   Pure; `link/moves.rs` is the wiring.
//! - `opening` — a person opening a card on another wall from its menu: the
//!   one ask allowed an empty brief, and why only a person's. Pure.
//! - `cast` — a screen across the flyway: the media connection's own ALPN,
//!   which shape each message rides, a key per connection and a counter for a
//!   nonce, consent, and what a relayed path is held to. Pure;
//!   `link/cast.rs` is the wiring.
//! - `directory` — the flyway's shared record of which walls are on it,
//!   signed by a key every member derives and sealed so the relay holding it
//!   reads no name: how a wall finds walls it has never met. Pure;
//!   `link/listing.rs` is the wiring and `wire.rs` the HTTP.
//! - `frame` — how those vocabularies share one frame.
//! - `wire` — iroh: QUIC, dial by public key, relay fallback. The only file
//!   that knows about the transport, so the transport stays replaceable.
//! - `here` — the rows the fleet keeps and the facts a wall announces.
//! - `link` — the thing that runs: a tick, the pushes, and the commands.
//!
//! **The wire carries work, never secrets.** The wall key is the one exception,
//! and a person carries it, in an invite, deliberately. A remote spawn needing
//! a credential the far machine lacks is refused there, with the reason; no
//! token, sealed or not, ever crosses, because a credential entered once must
//! not come to exist in two places.

/* There used to be an `allow(dead_code)` here, while the seal and the sync were
   built ahead of anything that called them, with a note that it came off with
   the transport. It has: every module is reached from `link.rs`, and what a
   non-test build does not call is `pub` and therefore not dead to a library
   crate in any case. */

/* The pure half lives in the flyway's core (`src-tauri/flyway-core`), which a
   phone links too (`docs/PHONE.md`, M1), and is re-exported here module for
   module so every `crate::flyway::seal::…` reads as it always did. `act` and
   `seeing` are the two drawn by dependency rather than by file: each re-exports
   its core module whole and adds the half that reads this machine (the
   provider table; the disk). Everything else below is the wiring — it reads
   the store, emits to the front end, or spawns. */
pub use flyway_core::{accounts, boards, cards, cast, directory, fleet, frame, look, moving, seal, session, sync, tail, wire};

pub mod act;
pub mod here;
pub mod key;
pub mod link;
pub mod opening;
pub mod reach;
pub mod seeing;

/// What this wall says of itself for `Facts::build` and `Facts::dev`: the
/// app's own version and whether this is a debug build — every lab wall and
/// `tauri dev`. Here rather than in `fleet`, where it was: since the fleet
/// moved into the core crate, a package version read there is the core's.
pub fn this_build() -> (String, bool) {
    (env!("CARGO_PKG_VERSION").to_string(), cfg!(debug_assertions))
}

#[cfg(test)]
mod tests {
    /// The build a wall announces is the app's, never the core crate's own
    /// version — which is what it silently became the moment `fleet.rs` moved.
    #[test]
    fn a_wall_says_the_apps_build() {
        let (build, dev) = super::this_build();
        assert_eq!(build, env!("CARGO_PKG_VERSION"));
        assert_ne!(build, "0.1.0", "that is flyway-core's version, not Volery's");
        assert_eq!(dev, cfg!(debug_assertions));
    }
}
