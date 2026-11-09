//! A file on another wall, read where the person is.
//!
//! Lyss, 2026-10-22: *"i'm not seeing the pictures from the remote au lt 288
//! over the flyway … Things that work locally should work accross the flyway
//! by construction, with no omission possible, things that don't work accross
//! should be exceptions."* And, the same afternoon, the boundary: *"allow
//! showing and reading files accross the flyway provided they sit inside a
//! project, preventing from showing files outside the projects, with file
//! paths from other machines becoming clickable."*
//!
//! And an hour later, once the narrower rule had been put to her, the boundary
//! that holds: **any file on the owning machine**, gated by the switch an
//! agent's `recall` of a card's words is gated by. Her argument, which is the reason
//! this file has no list of places: holding the flyway key is full trust
//! (`seal.rs`, `key.rs`) — a remote spawn already gets a whole shell with
//! `--dangerously-skip-permissions` — so a narrower read rule protects nothing
//! and only blocks useful files: a screenshot in `%TEMP%`, a download, a
//! memory file. No list of secrets either, for the same reason.
//!
//! A card on another wall draws its words here (`tail.rs`), and everything in
//! those words that pointed at a file stopped at the machine boundary: a
//! `show` figure said its copy was kept over there, `![x](path)` stayed words,
//! a path in prose or in a tool call was plain text. Each surface had decided
//! that on its own. This is the one road they all take instead: the wall a
//! card runs on answers for the files its cards name, and nothing else does.
//!
//! ### Who may: the recall's rule, not a new one
//!
//! A read starts nothing, and reaches past what this wall chose to publish —
//! which is exactly a `recall`, so it is `fleet::may_reach(Act::Recall, …)`
//! with the asking person as the origin: served if this wall takes work from
//! other walls, or if the asking wall is the one that opened the card. The
//! wiring applies it (`link/seen.rs`), since the second half is a fact about
//! the card the request names.
//!
//! ### What is still refused, and why it is a different boundary
//!
//! - **A share, in any spelling `show::is_remote` knows.** Not to protect this
//!   machine from a peer — the peer is trusted — but from a third host: a path
//!   on a share is an SMB handshake carrying this user's credentials to
//!   wherever the text named, and the text is an agent's, which may be words it
//!   read off a web page. The same allow-list a local picture passes, and the
//!   same check after resolution, since a junction can point at one.
//! - **Resolved before it is read.** `canonicalize` follows `..`, junctions and
//!   symlinks and turns an 8.3 name into the long one, so what is read and what
//!   the reply names are the file the filesystem means.
//!
//! A relative path counts from where the card *runs* (`store::session_of`'s
//! directory, a worktree for a card on a branch), which is the directory the
//! agent wrote it from.
//!
//! ### What is answered
//!
//! Four readings, each the counterpart of a local command, so the front end
//! asks the same question whichever wall the card is on:
//!
//! - `stat` — `find::classify_paths`: is each path a file or a folder.
//! - `names` — `find::resolve_names`: which file a bare name like `App.svelte`
//!   is, across the card's tree.
//! - `picture` — `show::picture_raw`: a picture by path, or by the name of the
//!   copy `show` kept, falling back to its path as a local figure does.
//! - `file` — a run of a file's bytes, for the viewer, in as many exchanges as
//!   it takes (`look.rs`'s parts, and its budget).
//!
//! The picture keeps every refusal a local one has, because it *is* the local
//! read: `show::picture_raw` is the function `read_picture` stands on. And the
//! asking wall checks the bytes again (`received`) before they go near a
//! `src=`, since they came from another machine.
//!
//! ### And a picture a tool call answered with
//!
//! A `Read` of a PNG, a browser screenshot: the result *is* an image block, and
//! opening that call on a card here draws it (`ToolCall.svelte`). The tail
//! carries a call's text and not its pictures — a screenshot is ~135k of base64
//! and the tail is re-read on every change — so a far fold opened onto nothing.
//! It is pulled instead, when the fold is opened, as one more `picture` reading
//! that names the call (`call`, `n`): the owning wall finds that `tool_result`
//! in the card's own session file and sends its `n`th image block
//! (`result_picture`). Not by path, because a screenshot was never a file and a
//! `Read`'s file may have changed since — the conversation's record is what was
//! seen. Behind a word of its own (`CALL_WORD`), since an older wall reads the
//! unknown fields as absent and would answer "no path was named".

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

/// The word a wall announces in `Facts::can` when it answers a `see`. Not one
/// of `fleet::CAN`, for `tail::WORD`'s reason.
pub const WORD: &str = "see";

/// The word a wall announces when it also answers a `picture` that names a
/// tool call rather than a file — "And a picture a tool call answered with".
pub const CALL_WORD: &str = "see_call";

/// The most paths one `stat` may ask about — `find::CLASSIFY_CAP`.
pub const STAT_MOST: usize = 400;

/// The most bare names one `names` may ask about.
pub const NAMES_MOST: usize = 200;

/// What one answer may spend on a file's bytes, as base64 — `look::BUDGET`,
/// for its reason: sized to the exchange's twenty seconds over a slow relay.
pub const BUDGET: usize = super::look::BUDGET;

/// The most a file may be — the viewer's own ceiling on this wall
/// (`find::DOC_CAP`, which `look::FILE_MOST` already is).
pub const FILE_MOST: u64 = super::look::FILE_MOST;

/// How many exchanges one file may take: `FILE_MOST` at a budget's worth of
/// bytes a round is seventeen, and this bounds a peer that never finishes.
pub const ROUNDS_MOST: usize = 32;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "msg", rename_all = "snake_case")]
pub enum SeeMsg {
    /// One reading of one card's files. `card` is the base a relative path
    /// counts from, and may be empty for an absolute one.
    See {
        id: String,
        #[serde(default)]
        card: String,
        ask: Sight,
    },
    /// The answer. Optional fields rather than an enum, for
    /// `tail::TailMsg::Tailed`'s reason: a field a newer build adds costs an
    /// older one nothing.
    Seen {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        why: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stats: Option<BTreeMap<String, String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        names: Option<BTreeMap<String, Vec<String>>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        picture: Option<Pictured>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        part: Option<Part>,
    },
}

/// What is asked.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Sight {
    Stat {
        paths: Vec<String>,
    },
    Names {
        names: Vec<String>,
    },
    /// By the copy `show` kept, or by path — and a kept copy that has gone
    /// falls back to `path`, as a local figure does. `measure` asks for the
    /// box alone; `have` is the stamp of a copy the asker already holds.
    /// `call` asks instead for the `n`th picture that tool call answered with,
    /// out of the card's own conversation, and is then the only thing read.
    Picture {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        call: Option<String>,
        #[serde(default, skip_serializing_if = "is_zero")]
        n: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        kept: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        path: Option<String>,
        #[serde(default)]
        measure: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        have: Option<String>,
    },
    File {
        path: String,
        #[serde(default)]
        from: u64,
    },
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

/// A picture, as the owning wall read it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Pictured {
    pub name: String,
    /// Base64. Empty when it is too large, unchanged since `have`, or only
    /// measured.
    #[serde(default)]
    pub data: String,
    #[serde(default)]
    pub bytes: u64,
    #[serde(default)]
    pub size: Option<(u32, u32)>,
    #[serde(default)]
    pub too_large: bool,
    /// Its length and when it was written, on the owning wall's clock —
    /// compared only with itself.
    #[serde(default)]
    pub stamp: Option<String>,
    /// Nothing changed since the asker's `have`.
    #[serde(default)]
    pub same: bool,
    /// The kept copy had gone, and this is the file it came from, as it is now.
    #[serde(default)]
    pub stale: bool,
}

/// A run of one file's bytes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Part {
    pub name: String,
    /// Where it is on the owning wall, in that wall's spelling — for the
    /// viewer to say which file it is, never to be opened here.
    pub full: String,
    pub size: u64,
    #[serde(default)]
    pub stamp: Option<String>,
    pub from: u64,
    pub data: String,
}

/// A size in megabytes, as the sentences here say one. `pub` because the
/// owning wall's half (`src-tauri`'s `flyway::seeing`) says sizes the same way.
pub fn mb(n: u64) -> String {
    let m = n as f64 / (1024.0 * 1024.0);
    if m >= 10.0 { format!("{m:.0} MB") } else { format!("{m:.1} MB") }
}

/* ── the asking wall's half ─────────────────────────────────────────────── */

/// The answer to request `id`, out of everything an exchange brought back —
/// or the sentence to show.
pub fn answer_in(frames: impl IntoIterator<Item = SeeMsg>, id: &str, host: &str) -> Result<SeeMsg, String> {
    let got = frames.into_iter().find(|m| matches!(m, SeeMsg::Seen { id: i, .. } if i == id));
    match got {
        None => Err(format!("{host} did not answer for that file")),
        Some(SeeMsg::Seen { why: Some(why), .. }) => {
            let why: String = crate::clean::scrub(why.trim()).chars().take(400).collect();
            Err(if why.is_empty() { format!("{host} could not read that file") } else { why })
        }
        Some(m) => Ok(m),
    }
}

/// A file arriving in parts, held to what its first part said it was.
#[derive(Debug, Default)]
pub struct Gathering {
    pub name: String,
    pub full: String,
    pub size: u64,
    pub stamp: Option<String>,
    pub got: Vec<u8>,
    started: bool,
}

impl Gathering {
    /// Fold one part in. `Ok(true)` when the file is whole.
    pub fn take(&mut self, p: Part, host: &str) -> Result<bool, String> {
        if !self.started {
            if p.size > FILE_MOST {
                return Err(format!("{host} offered a file of {}, over the {} the viewer reads", mb(p.size), mb(FILE_MOST)));
            }
            self.name = super::look::plain_name(&p.name);
            self.full = crate::clean::scrub(&p.full).chars().take(400).collect();
            self.size = p.size;
            self.stamp = p.stamp.clone();
            self.started = true;
        } else if p.size != self.size || p.stamp != self.stamp {
            return Err(format!("{} changed on {host} while it was being carried — open it again", self.name));
        }
        if p.from != self.got.len() as u64 {
            return Err(format!("{host} sent part of {} out of order", self.name));
        }
        let bytes = crate::unbase64(&p.data).ok_or_else(|| format!("{host} sent bytes for {} that do not decode", self.name))?;
        if self.got.len() as u64 + bytes.len() as u64 > self.size {
            return Err(format!("{host} sent more of {} than it said there was", self.name));
        }
        if bytes.is_empty() && (self.got.len() as u64) < self.size {
            return Err(format!("{host} stopped sending {}", self.name));
        }
        self.got.extend_from_slice(&bytes);
        Ok(self.got.len() as u64 == self.size)
    }
}

/// A cache key that names a picture or a file by the wall, the card and what
/// was asked — never by a bare file name, which two walls (or two cards) can
/// share for two different files. FNV-1a, written out rather than borrowed:
/// `DefaultHasher` promises nothing across Rust releases, and a cache whose
/// keys moved under it would only be a slower cache, but there is no reason to
/// accept even that.
pub fn key(parts: &[&str]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for p in parts {
        for b in p.as_bytes().iter().chain(std::iter::once(&0u8)) {
            h ^= *b as u64;
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    format!("{h:016x}")
}

/// A cached picture on disk: one file, a line of JSON saying what it is and
/// then the bytes — one file rather than two so the budget sweep can never
/// keep one half of a pair.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Held {
    pub name: String,
    #[serde(default)]
    pub stamp: Option<String>,
    #[serde(default)]
    pub stale: bool,
}

pub fn write_held(at: &Path, meta: &Held, bytes: &[u8]) -> Result<(), String> {
    let mut out = serde_json::to_vec(meta).map_err(|e| e.to_string())?;
    out.push(b'\n');
    out.extend_from_slice(bytes);
    if let Some(dir) = at.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(at, out).map_err(|e| e.to_string())
}

pub fn read_held(at: &Path) -> Option<(Held, Vec<u8>)> {
    let all = std::fs::read(at).ok()?;
    let cut = all.iter().position(|b| *b == b'\n')?;
    let meta: Held = serde_json::from_slice(&all[..cut]).ok()?;
    Some((meta, all[cut + 1..].to_vec()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_is_held_to_what_its_first_part_said() {
        let part = |from: u64, data: &[u8], stamp: &str| Part {
            name: r"..\x.ts".into(),
            full: "C:/p/x.ts".into(),
            size: 4,
            stamp: Some(stamp.into()),
            from,
            data: crate::base64(data),
        };
        let mut g = Gathering::default();
        assert!(!g.take(part(0, b"ab", "1"), "lap").unwrap());
        assert_eq!(g.name, "x.ts", "a name from elsewhere is only a name");
        assert!(g.take(part(2, b"cd", "2"), "lap").unwrap_err().contains("changed"));
        let mut g = Gathering::default();
        g.take(part(0, b"ab", "1"), "lap").unwrap();
        assert!(g.take(part(2, b"cde", "1"), "lap").unwrap_err().contains("more of"));
    }

    #[test]
    fn the_words_round_trip_and_a_newer_answer_still_reads() {
        for m in [
            SeeMsg::See { id: "r".into(), card: "c".into(), ask: Sight::Stat { paths: vec!["a".into()] } },
            SeeMsg::See { id: "r".into(), card: "".into(), ask: Sight::Picture { call: None, n: 0, kept: Some("k".into()), path: None, measure: true, have: None } },
            SeeMsg::Seen { id: "r".into(), why: Some("no".into()), stats: None, names: None, picture: None, part: None },
        ] {
            let back: SeeMsg = serde_json::from_value(serde_json::to_value(&m).unwrap()).unwrap();
            assert_eq!(back, m);
        }
        let newer: SeeMsg = serde_json::from_value(serde_json::json!({ "msg": "seen", "id": "r", "later": [1] })).unwrap();
        assert!(matches!(newer, SeeMsg::Seen { why: None, .. }));
    }

    #[test]
    fn a_key_names_the_wall_and_the_card_and_what_was_asked() {
        assert_ne!(key(&["lap", "c1", "a.png"]), key(&["lap", "c2", "a.png"]));
        assert_ne!(key(&["lap", "c1", "a.png"]), key(&["lab", "c1", "a.png"]));
        assert_ne!(key(&["ab", "c"]), key(&["a", "bc"]), "the separator is part of the key");
        assert_eq!(key(&["lap", "c1", "a.png"]).len(), 16);
    }

    #[test]
    fn a_held_picture_reads_back_as_written() {
        let at = std::env::temp_dir().join(format!("skein-held-{}-{}.pic", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let meta = Held { name: "a.png".into(), stamp: Some("3-9".into()), stale: false };
        write_held(&at, &meta, b"\x89PNG\nrest").unwrap();
        let (m, b) = read_held(&at).unwrap();
        assert_eq!(m, meta);
        assert_eq!(b, b"\x89PNG\nrest", "a newline in the bytes is the bytes'");
        let _ = std::fs::remove_file(at);
    }
}
