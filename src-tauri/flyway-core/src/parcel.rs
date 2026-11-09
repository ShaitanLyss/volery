//! What a parcel looks like on the wire: the request a far wall reads when a
//! card sends files to a card on another wall (`send_files`, sink 560a0bbf).
//!
//! Only the types cross. Gathering, staging, the caps and the name rules are
//! this wall's business and stay in `src-tauri/src/parcel.rs`, which
//! re-exports these and adds `check` and `parcel` through its `CarriedHere`
//! trait — the orphan rule's price for moving a type whose methods read app
//! policy.

/// A top-level entry: one path the sender named.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Top {
    pub name: String,
    pub dir: bool,
    pub files: usize,
    pub bytes: u64,
    /// A secret-shaped file named directly, so sent and flagged.
    pub secret: bool,
}

/// Something under a named folder that was not sent, and why.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Left {
    /// Relative to the landing folder, `/`-separated, with a trailing `/` for a
    /// folder.
    pub path: String,
    pub why: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Staged {
    /// The id the far wall pulls (`stage-…`).
    pub id: String,
    /// Each file's landing name and size, in the order the stage serves them.
    pub files: Vec<(String, u64)>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Carried {
    pub stages: Vec<Staged>,
    pub tops: Vec<Top>,
    pub left: Vec<Left>,
    #[serde(default)]
    pub left_more: usize,
}

impl Carried {
    pub fn files(&self) -> usize {
        self.stages.iter().map(|s| s.files.len()).sum()
    }
    pub fn bytes(&self) -> u64 {
        self.stages.iter().flat_map(|s| &s.files).map(|f| f.1).sum()
    }
}
