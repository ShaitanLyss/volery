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
//! - `tail` — one card's conversation, pulled by a wall with a panel open on
//!   it and answered in the same exchange. Pure.
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

pub mod cards;
pub mod fleet;
pub mod frame;
pub mod here;
pub mod key;
pub mod link;
pub mod reach;
pub mod seal;
pub mod session;
pub mod sync;
pub mod tail;
pub mod wire;
