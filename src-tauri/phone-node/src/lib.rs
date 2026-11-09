//! The phone node — a receive-only participant on the flyway (`docs/PHONE.md`,
//! M2a).
//!
//! `node` is the whole of it. This crate exists as its own workspace member
//! rather than a module inside `flyway-core` because it is the *wiring* half —
//! the thing that dials and reads — where `flyway-core` is the pure
//! vocabularies and the transport. A wall has its own wiring
//! (`src-tauri/src/flyway/link.rs`); a phone links this.

pub mod node;

pub use node::{Digest, Node, Sighting};
