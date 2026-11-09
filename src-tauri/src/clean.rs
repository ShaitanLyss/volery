//! What an impossible character is, and taking it out. Lives in the flyway's
//! core (`flyway_core::clean`, whose note is the reasoning), because every text
//! that crosses to another wall passes through it too; re-exported so
//! `crate::clean::scrub` reads as it always did.

pub use flyway_core::clean::*;
