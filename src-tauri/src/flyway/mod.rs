//! The flyway: the wire between one person's walls.
//!
//! A volery is the enclosure; a flyway is the route between them. This is the
//! route — what lets a project exist on several machines at once, with cards
//! hosted wherever the repo, the toolchain and the credentials actually are.
//!
//! The design is in `.claude/rules/flyway.md`. What is here so far is the half
//! that needs no network and can be tested without one:
//!
//! - `seal` — the key, the rooms it names, and the frames it seals. Everything
//!   above it may assume the pipe is hostile, which is what makes the choice of
//!   transport an engineering decision rather than a security one.
//!
//! What is deliberately *not* here yet is the transport. The first one will be
//! sealed frames over TCP/443 through `crate::forge::tls` — not because it is
//! the fastest but because it is the one that certainly works from an office
//! network, where the gateway intercepts TLS and QUIC is commonly dropped
//! outright. `forge::tls` merges the native root store with `webpki-roots`
//! precisely so an intercepted connection validates, and that merge is this
//! app's hardest-won network lesson; anything here that grew its own root set
//! would fail on exactly one network and work everywhere it was tested.

/* The seal is built ahead of the thing that will call it, so in a non-test
   build most of it is reached by nothing yet. Allowed here rather than left to
   warn, because nine warnings nobody can act on are what hides the tenth that
   somebody can — and narrowed to this module so the rest of the crate keeps
   its unused code loud.

   **This comes off with the transport.** If it is still here once frames are
   going over a wire, something above is not calling what it should be. */
#![allow(dead_code)]

pub mod fleet;
pub mod key;
pub mod seal;
pub mod session;
pub mod sync;
