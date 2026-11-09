//! The one cap every text field is held to. Lives in the flyway's core
//! (`flyway_core::clip`, whose note is the reasoning), because the wire caps
//! with it too; re-exported so `crate::clip::keep` reads as it always did.

pub use flyway_core::clip::*;
