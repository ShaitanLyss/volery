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
use std::path::{Path, PathBuf};

/// The word a wall announces in `Facts::can` when it answers a `see`. Not one
/// of `fleet::CAN`, for `tail::WORD`'s reason.
pub const WORD: &str = "see";

/// The word a wall announces when it also answers a `picture` that names a
/// tool call rather than a file — "And a picture a tool call answered with".
pub const CALL_WORD: &str = "see_call";

/// The longest tool-use id believed. The CLI's are `toolu_` and two dozen
/// characters; this bounds what is searched for, not what is drawn.
const CALL_ID_MOST: usize = 128;

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

/// Where a relative path counts from, and where `show` keeps its copies.
pub struct Grounds {
    pub base: Option<PathBuf>,
    pub shown: PathBuf,
    /// The card's session file, where a tool call's pictures are read from.
    pub transcript: Option<PathBuf>,
    /// This wall's name, for the sentences.
    pub me: String,
}

/// A path as the filesystem spells it, or why there is none. The verbatim
/// prefix comes off (`supervisor::plain`'s reason); a share after resolution —
/// a junction pointing at one — is refused here rather than read.
fn real(p: &Path) -> Result<PathBuf, std::io::Error> {
    let canon = std::fs::canonicalize(p)?;
    let s = canon.to_string_lossy();
    if s.starts_with(r"\\?\UNC\") {
        return Err(std::io::Error::other("a share"));
    }
    let plain = s.strip_prefix(r"\\?\").unwrap_or(&s).to_string();
    if plain.starts_with(r"\\") {
        return Err(std::io::Error::other("a share"));
    }
    Ok(PathBuf::from(plain))
}

fn name_of(p: &str) -> String {
    p.rsplit(['/', '\\']).find(|s| !s.is_empty()).unwrap_or(p).chars().take(120).collect()
}

/// Where `raw` is on this wall, resolved — or the sentence that says why
/// not. See the module note for the one thing refused.
pub fn reach(raw: &str, g: &Grounds) -> Result<PathBuf, String> {
    let raw = crate::clean::scrub(raw.trim()).into_owned();
    let name = name_of(&raw);
    if raw.is_empty() {
        return Err("no path was named".into());
    }
    if crate::show::is_remote(&raw) {
        return Err(format!("{name} is on a network share, which is never read for another wall"));
    }
    let asked = Path::new(&raw);
    let joined = if asked.is_absolute() {
        asked.to_path_buf()
    } else {
        match &g.base {
            Some(b) => b.join(asked),
            None => return Err(format!("{name} counts from a card {} does not have", g.me)),
        }
    };
    real(&joined).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => format!("{name} is not there on {}", g.me),
        _ if e.to_string() == "a share" => format!("{name} is on a network share, which is never read for another wall"),
        _ => format!("{name} could not be read on {}: {e}", g.me),
    })
}

/// A file's length and when it was written, as one string — what tells the
/// asker whether the copy it holds is still the file.
pub fn stamp_of(meta: &std::fs::Metadata) -> String {
    let at = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{}-{at}", meta.len())
}

fn mb(n: u64) -> String {
    let m = n as f64 / (1024.0 * 1024.0);
    if m >= 10.0 { format!("{m:.0} MB") } else { format!("{m:.1} MB") }
}

/// The owning wall's answer to one `see`. Blocking: it stats, canonicalizes
/// and reads, so the caller runs it off the main thread.
pub fn answer(id: &str, ask: Sight, g: &Grounds) -> SeeMsg {
    let said = |r: Result<Said, String>| {
        let mut m = SeeMsg::Seen { id: id.to_string(), why: None, stats: None, names: None, picture: None, part: None };
        if let SeeMsg::Seen { why, stats, names, picture, part, .. } = &mut m {
            match r {
                Err(e) => *why = Some(e),
                Ok(Said::Stats(s)) => *stats = Some(s),
                Ok(Said::Names(n)) => *names = Some(n),
                Ok(Said::Picture(p)) => *picture = Some(p),
                Ok(Said::Part(p)) => *part = Some(p),
            }
        }
        m
    };
    said(match ask {
        Sight::Stat { paths } => {
            let mut out = BTreeMap::new();
            for raw in paths.into_iter().take(STAT_MOST) {
                /* A refusal is an absence here: the front end draws plain text
                   for a path it is told nothing about, which is what a share
                   or a path that is not there should be. */
                let Ok(full) = reach(&raw, g) else { continue };
                let Ok(meta) = std::fs::metadata(&full) else { continue };
                out.insert(raw, if meta.is_dir() { "dir" } else { "file" }.to_string());
            }
            Ok(Said::Stats(out))
        }
        Sight::Names { names } => names_here(names, g).map(Said::Names),
        Sight::Picture { call: Some(call), n, measure, .. } => result_picture(&call, n, measure, g).map(Said::Picture),
        Sight::Picture { kept, path, measure, have, call: None, .. } => {
            picture_here(kept, path, measure, have, g).map(Said::Picture)
        }
        Sight::File { path, from } => part_here(&path, from, g).map(Said::Part),
    })
}

/// What one `see` came to, before it is put in a frame.
enum Said {
    Stats(BTreeMap<String, String>),
    Names(BTreeMap<String, Vec<String>>),
    Picture(Pictured),
    Part(Part),
}

fn names_here(asked: Vec<String>, g: &Grounds) -> Result<BTreeMap<String, Vec<String>>, String> {
    let Some(base) = g.base.clone() else {
        return Err(format!("that card is not on {}", g.me));
    };
    reach(&base.to_string_lossy(), g)?;
    let asked: Vec<String> = asked.into_iter().take(NAMES_MOST).collect();
    let found = crate::find::resolve_names(&base.to_string_lossy(), &asked)?;
    /* Each match is held to the same rule as a path: ripgrep walks the tree,
       and a junction in it to a share is still one. */
    Ok(found
        .into_iter()
        .map(|(n, hits)| {
            let hits = hits.into_iter().filter(|h| reach(h, g).is_ok()).collect();
            (n, hits)
        })
        .collect())
}

fn picture_here(kept: Option<String>, path: Option<String>, measure: bool, have: Option<String>, g: &Grounds) -> Result<Pictured, String> {
    let mut stale = false;
    let full = match kept {
        Some(k) => {
            if !crate::show::is_kept_name(&k) {
                return Err("that is not the name of a kept picture".into());
            }
            let at = g.shown.join(&k);
            if at.is_file() {
                at
            } else {
                /* Swept by the budget: the file it came from, as it is now. */
                let Some(p) = path.filter(|p| !p.trim().is_empty()) else {
                    return Err(format!("{k} is no longer kept on {}", g.me));
                };
                stale = true;
                reach(&p, g).map_err(|e| format!("its kept copy has gone on {}, and {e}", g.me))?
            }
        }
        None => reach(path.as_deref().unwrap_or(""), g)?,
    };
    let shown = full.to_string_lossy().to_string();
    let name = name_of(&shown);
    let meta = std::fs::metadata(&full).map_err(|_| format!("{name} is not there on {}", g.me))?;
    if !meta.is_file() {
        return Err(format!("{name} is a folder on {}", g.me));
    }
    let stamp = stamp_of(&meta);
    if measure {
        use std::io::Read;
        let mut head = Vec::new();
        if let Ok(f) = std::fs::File::open(&full) {
            let _ = f.take(crate::show::SIZE_HEAD as u64).read_to_end(&mut head);
        }
        return Ok(Pictured {
            name,
            bytes: meta.len(),
            size: crate::show::picture_size(&head),
            too_large: meta.len() > crate::show::MAX_PICTURE || crate::show::too_many_pixels_in(&head),
            stamp: Some(stamp),
            stale,
            ..Pictured::default()
        });
    }
    if !stale && have.as_deref() == Some(stamp.as_str()) {
        return Ok(Pictured { name, bytes: meta.len(), stamp: Some(stamp), same: true, ..Pictured::default() });
    }
    let raw = crate::show::picture_raw(&full)?;
    Ok(Pictured {
        name,
        data: raw.data.as_deref().map(crate::base64).unwrap_or_default(),
        bytes: raw.bytes,
        size: raw.size,
        too_large: raw.too_large,
        stamp: Some(stamp),
        same: false,
        stale,
    })
}

/// A tool-use id as the CLI writes one — letters, digits, `_` and `-` — which
/// is also what lets a substring search for it stand as a prefilter.
fn is_call_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= CALL_ID_MOST && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// The `n`th picture the tool call `call` answered with, out of a session
/// file: the `tool_result` naming it in a record's content, and its base64
/// image blocks in order — the shape `classify.ts::picturesOf` reads, on the
/// wire and on disk alike. Only a line that mentions the id is parsed, so a
/// transcript of a hundred megabytes costs one pass of `contains`. `None` when
/// the call, or that many pictures in it, is not there.
pub fn picture_of_call(transcript: &Path, call: &str, n: u32) -> Result<Option<Vec<u8>>, String> {
    use std::io::BufRead;
    let f = std::fs::File::open(transcript).map_err(|e| e.to_string())?;
    let mut lines = std::io::BufReader::new(f);
    let mut line = String::new();
    loop {
        line.clear();
        if lines.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
            return Ok(None);
        }
        if !line.contains(call) {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        let Some(content) = v.pointer("/message/content").and_then(|c| c.as_array()) else { continue };
        let says = |b: &serde_json::Value, k: &str| b.get(k).and_then(|t| t.as_str()).map(str::to_string);
        for b in content {
            if says(b, "type").as_deref() != Some("tool_result") || says(b, "tool_use_id").as_deref() != Some(call) {
                continue;
            }
            let Some(blocks) = b.get("content").and_then(|c| c.as_array()) else { return Ok(None) };
            let data = blocks
                .iter()
                .filter(|x| says(x, "type").as_deref() == Some("image"))
                .filter_map(|x| x.get("source"))
                .filter(|s| says(s, "type").as_deref() == Some("base64"))
                .filter_map(|s| s.get("data").and_then(|d| d.as_str()))
                .nth(n as usize);
            return Ok(data.and_then(crate::unbase64));
        }
    }
}

/// A tool call's picture, as an answer, meeting every refusal a picture read
/// from a file meets in `picture_raw`: typed by its own bytes, `MAX_PICTURE`,
/// and `MAX_PIXELS` by the header's numbers. Never stamped — what a call
/// answered with does not change, so the asker keeps it as it keeps a `show`
/// copy.
fn result_picture(call: &str, n: u32, measure: bool, g: &Grounds) -> Result<Pictured, String> {
    let call = call.trim();
    if !is_call_id(call) {
        return Err("that is not the name of a tool call".into());
    }
    let Some(t) = &g.transcript else {
        return Err(format!("that card has no conversation on {} yet", g.me));
    };
    let name = format!("picture {} of that call", n + 1);
    let bytes = picture_of_call(t, call, n)
        .map_err(|e| format!("that card's conversation could not be read on {}: {e}", g.me))?
        .ok_or_else(|| format!("{name} is not in that card's conversation on {}", g.me))?;
    if crate::show::sniff_picture(&bytes).is_none() {
        return Err(format!("{name} is not a picture this window can draw"));
    }
    let too_large = bytes.len() as u64 > crate::show::MAX_PICTURE || crate::show::too_many_pixels_in(&bytes);
    Ok(Pictured {
        name,
        data: if measure || too_large { String::new() } else { crate::base64(&bytes) },
        bytes: bytes.len() as u64,
        size: crate::show::picture_size(&bytes),
        too_large,
        ..Pictured::default()
    })
}

fn part_here(path: &str, from: u64, g: &Grounds) -> Result<Part, String> {
    let full = reach(path, g)?;
    let shown = full.to_string_lossy().to_string();
    let name = name_of(&shown);
    let meta = std::fs::metadata(&full).map_err(|_| format!("{name} is not there on {}", g.me))?;
    if meta.is_dir() {
        return Err(format!("{name} is a folder on {}, and a folder is not opened from another wall", g.me));
    }
    if meta.len() > FILE_MOST {
        return Err(format!("{name} is {}, over the {} the viewer reads", mb(meta.len()), mb(FILE_MOST)));
    }
    let size = meta.len();
    let most = (BUDGET / 4 * 3).min(size.saturating_sub(from) as usize);
    let data = if most == 0 {
        Vec::new()
    } else {
        use std::io::{Read, Seek, SeekFrom};
        let mut f = std::fs::File::open(&full).map_err(|e| format!("{name} could not be read on {}: {e}", g.me))?;
        f.seek(SeekFrom::Start(from)).map_err(|e| e.to_string())?;
        let mut out = Vec::with_capacity(most);
        f.take(most as u64).read_to_end(&mut out).map_err(|e| e.to_string())?;
        out
    };
    Ok(Part { name, full: shown, size, stamp: Some(stamp_of(&meta)), from, data: crate::base64(&data) })
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

/// A picture from another wall, checked here before it goes anywhere near a
/// `src=`: the bytes decode, are no more than a picture here may be, are a
/// picture by their own first bytes (never the name the peer gave), and do not
/// declare more pixels than one decode may cost. What it says about its size
/// is read off the bytes, not believed.
#[derive(Debug, PartialEq)]
pub struct Checked {
    /// `None` when too large.
    pub data: Option<Vec<u8>>,
    pub kind: &'static str,
    pub bytes: u64,
    pub size: Option<(u32, u32)>,
    pub too_large: bool,
}

pub fn received(p: &Pictured, host: &str) -> Result<Checked, String> {
    let name = crate::clean::scrub(&p.name).chars().take(120).collect::<String>();
    if p.too_large || p.data.is_empty() {
        /* Nothing to check but the numbers, which only ever say "too large". */
        return Ok(Checked { data: None, kind: "png", bytes: p.bytes, size: p.size, too_large: true });
    }
    if p.data.len() as u64 > crate::show::MAX_PICTURE / 3 * 4 + 8 {
        return Err(format!("{host} sent more of {name} than a picture may be"));
    }
    let bytes = crate::unbase64(&p.data).ok_or_else(|| format!("{host} sent bytes for {name} that do not decode"))?;
    if bytes.len() as u64 > crate::show::MAX_PICTURE {
        return Err(format!("{host} sent more of {name} than a picture may be"));
    }
    let Some(kind) = crate::show::sniff_picture(&bytes) else {
        return Err(format!("{host} sent {name} as a picture, and its bytes are not one"));
    };
    let size = crate::show::picture_size(&bytes);
    if crate::show::too_many_pixels_in(&bytes) {
        return Ok(Checked { data: None, kind, bytes: bytes.len() as u64, size, too_large: true });
    }
    Ok(Checked { kind, bytes: bytes.len() as u64, size, too_large: false, data: Some(bytes) })
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

    /// A scratch tree: a card's directory and a folder beside it.
    struct Tree {
        top: PathBuf,
    }
    impl Drop for Tree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.top);
        }
    }

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x02\0\0\0\x03\x08\x06\0\0\0";

    fn tree() -> (Tree, Grounds) {
        let top = std::env::temp_dir().join(format!("skein-seeing-{}", crate::store::uuid_v4()));
        let p = |s: &str| top.join(s);
        for d in ["proj/src", "proj/.scratch-x", "elsewhere", "shown"] {
            std::fs::create_dir_all(p(d)).unwrap();
        }
        std::fs::write(p("proj/src/a.ts"), b"export const a = 1;\n").unwrap();
        std::fs::write(p("proj/.scratch-x/shot.png"), PNG).unwrap();
        std::fs::write(p("proj/.env.local"), b"TOKEN=x").unwrap();
        std::fs::write(p("elsewhere/note.md"), b"# note").unwrap();
        /* A conversation in the CLI's own shape: the call, and a result holding
           some words and two pictures, the second a PNG. */
        let png = crate::base64(PNG);
        let records = [
            serde_json::json!({ "type": "assistant", "message": { "content": [
                { "type": "tool_use", "id": "toolu_01Shot", "name": "Read", "input": { "file_path": "shot.png" } } ] } }),
            serde_json::json!({ "type": "user", "message": { "content": [
                { "type": "tool_result", "tool_use_id": "toolu_01Other", "content": [
                    { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": png } } ] } ] } }),
            serde_json::json!({ "type": "user", "message": { "content": [
                { "type": "tool_result", "tool_use_id": "toolu_01Shot", "content": [
                    { "type": "text", "text": "two pictures" },
                    { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": crate::base64(b"not a picture") } },
                    { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": png } } ] } ] } }),
        ];
        let jsonl: String = records.iter().map(|r| format!("{r}\n")).collect();
        std::fs::write(p("session.jsonl"), jsonl).unwrap();
        let g = Grounds { base: Some(p("proj")), shown: p("shown"), transcript: Some(p("session.jsonl")), me: "lap".into() };
        (Tree { top }, g)
    }

    /// A picture a tool call answered with is read out of the card's own
    /// conversation — by the call's id and its place among the pictures — and
    /// meets the same refusals a picture read from a file does.
    #[test]
    fn a_calls_picture_crosses_out_of_the_conversation() {
        let (_t, mut g) = tree();
        let call = |id: &str, n: u32, measure: bool| Sight::Picture {
            call: Some(id.into()),
            n,
            kept: None,
            path: None,
            measure,
            have: None,
        };
        let SeeMsg::Seen { picture: Some(p), why: None, .. } = answer("r", call("toolu_01Shot", 1, false), &g) else { panic!() };
        assert_eq!(p.size, Some((2, 3)));
        assert!(p.stamp.is_none(), "what a call answered with never changes");
        assert_eq!(received(&p, "lap").unwrap().data.as_deref(), Some(PNG));
        /* Measured: the box and no bytes. */
        let SeeMsg::Seen { picture: Some(m), .. } = answer("r", call("toolu_01Shot", 1, true), &g) else { panic!() };
        assert!(m.data.is_empty() && m.size == Some((2, 3)));
        /* The first image block of that call is not a picture: refused, not drawn. */
        let SeeMsg::Seen { why: Some(w), .. } = answer("r", call("toolu_01Shot", 0, false), &g) else { panic!() };
        assert!(w.contains("not a picture"), "{w}");
        let SeeMsg::Seen { why: Some(w), .. } = answer("r", call("toolu_01Shot", 2, false), &g) else { panic!() };
        assert!(w.contains("not in that card's conversation on lap"), "{w}");
        let SeeMsg::Seen { why: Some(w), .. } = answer("r", call("toolu_01Gone", 0, false), &g) else { panic!() };
        assert!(w.contains("not in that card's conversation"), "{w}");
        /* An id is only ever an id: nothing that could be a path or a pattern. */
        for bad in ["", "../x", "toolu \"x\"", &"t".repeat(CALL_ID_MOST + 1)] {
            let SeeMsg::Seen { why: Some(w), .. } = answer("r", call(bad, 0, false), &g) else { panic!() };
            assert!(w.contains("not the name of a tool call"), "{bad}: {w}");
        }
        g.transcript = None;
        let SeeMsg::Seen { why: Some(w), .. } = answer("r", call("toolu_01Shot", 1, false), &g) else { panic!() };
        assert!(w.contains("no conversation on lap"), "{w}");
    }

    /// A wall from before `call` reads the frame without it — so the asker
    /// must not send it there, which is what `CALL_WORD` is for — and the
    /// default `n` is not written, so an ordinary picture's frame is unchanged.
    #[test]
    fn a_call_rides_the_picture_reading_and_costs_an_ordinary_one_nothing() {
        let plain = SeeMsg::See {
            id: "r".into(),
            card: "c".into(),
            ask: Sight::Picture { call: None, n: 0, kept: None, path: Some("a.png".into()), measure: false, have: None },
        };
        let v = serde_json::to_value(&plain).unwrap();
        assert!(v["ask"].get("call").is_none() && v["ask"].get("n").is_none(), "{v}");
        let called = SeeMsg::See {
            id: "r".into(),
            card: "c".into(),
            ask: Sight::Picture { call: Some("toolu_1".into()), n: 2, kept: None, path: None, measure: false, have: None },
        };
        let back: SeeMsg = serde_json::from_value(serde_json::to_value(&called).unwrap()).unwrap();
        assert_eq!(back, called);
    }

    /// Any file on the machine, by Lyss's decision — beside the card or
    /// anywhere else, a secret included — resolved before it is named.
    #[test]
    fn any_file_is_reached_and_named_as_the_disk_names_it() {
        let (t, g) = tree();
        let a = reach("src/a.ts", &g).unwrap();
        assert!(a.ends_with(Path::new("proj").join("src").join("a.ts")), "{a:?}");
        assert!(reach(&t.top.join("elsewhere/note.md").to_string_lossy(), &g).is_ok(), "outside the card's tree");
        assert!(reach("../elsewhere/note.md", &g).is_ok(), "a `..` is resolved");
        assert!(reach(".env.local", &g).is_ok(), "no list of secrets: the key is the trust");
        assert!(!reach("src/../src/a.ts", &g).unwrap().to_string_lossy().contains(".."));
        assert!(reach("src/nope.ts", &g).unwrap_err().contains("not there on lap"));
    }

    /// The one boundary left, and it is about a third host rather than the
    /// peer: a path on a share is a handshake carrying this user's credentials.
    #[test]
    fn a_share_is_never_asked_about() {
        let (_t, g) = tree();
        for s in [r"\\host\share\x.png", r"\\?\UNC\host\share\x", r"\??\UNC\host\x", r"\\.\C:\..\UNC\host\x", "//host/share/x"] {
            assert!(reach(s, &g).unwrap_err().contains("share"), "{s}");
        }
    }

    #[test]
    fn a_relative_path_needs_a_card() {
        let (_t, mut g) = tree();
        g.base = None;
        assert!(reach("src/a.ts", &g).unwrap_err().contains("counts from a card"));
    }

    #[test]
    fn a_stat_answers_what_is_there() {
        let (_t, g) = tree();
        let asked = vec!["src/a.ts".into(), "src".into(), "nope.ts".into(), r"\\host\s\x.ts".into()];
        let SeeMsg::Seen { stats: Some(s), .. } = answer("r", Sight::Stat { paths: asked }, &g) else { panic!() };
        assert_eq!(s.get("src/a.ts").map(String::as_str), Some("file"));
        assert_eq!(s.get("src").map(String::as_str), Some("dir"));
        assert_eq!(s.len(), 2, "{s:?}");
    }

    #[test]
    fn a_picture_crosses_checked_and_a_file_crosses_whole() {
        let (_t, g) = tree();
        let pic = |have: Option<String>| Sight::Picture { call: None, n: 0, kept: None, path: Some(".scratch-x/shot.png".into()), measure: false, have };
        let SeeMsg::Seen { picture: Some(p), why: None, .. } = answer("r", pic(None), &g) else { panic!() };
        assert_eq!(p.size, Some((2, 3)));
        let c = received(&p, "lap").unwrap();
        assert_eq!(c.kind, "png");
        assert_eq!(c.size, Some((2, 3)));
        /* The same stamp back is `same`, and no bytes. */
        let SeeMsg::Seen { picture: Some(q), .. } = answer("r", pic(p.stamp.clone()), &g) else { panic!() };
        assert!(q.same && q.data.is_empty());
        /* Measured: the box, and nothing else. */
        let SeeMsg::Seen { picture: Some(m), .. } =
            answer("r", Sight::Picture { call: None, n: 0, kept: None, path: Some(".scratch-x/shot.png".into()), measure: true, have: None }, &g)
        else {
            panic!()
        };
        assert!(m.data.is_empty() && m.size == Some((2, 3)) && !m.too_large);
        /* A text file is not a picture, here or there. */
        let SeeMsg::Seen { why: Some(w), .. } =
            answer("r", Sight::Picture { call: None, n: 0, kept: None, path: Some("src/a.ts".into()), measure: false, have: None }, &g)
        else {
            panic!()
        };
        assert!(w.contains("not a picture"), "{w}");
        let mut gat = Gathering::default();
        let SeeMsg::Seen { part: Some(part), .. } = answer("r", Sight::File { path: "src/a.ts".into(), from: 0 }, &g) else { panic!() };
        assert!(gat.take(part, "lap").unwrap());
        assert_eq!(gat.got, b"export const a = 1;\n");
        assert_eq!(gat.name, "a.ts");
        let SeeMsg::Seen { why: Some(w), .. } = answer("r", Sight::File { path: "src".into(), from: 0 }, &g) else { panic!() };
        assert!(w.contains("folder"), "{w}");
    }

    /// A file larger than one answer arrives over several, and whole.
    #[test]
    fn a_large_file_crosses_in_parts() {
        let (t, g) = tree();
        let big: Vec<u8> = (0..=255u8).cycle().take(BUDGET * 2).collect();
        std::fs::write(t.top.join("proj/big.bin"), &big).unwrap();
        let mut gat = Gathering::default();
        let mut from = 0;
        let mut rounds = 0;
        loop {
            rounds += 1;
            let SeeMsg::Seen { part: Some(part), .. } = answer("r", Sight::File { path: "big.bin".into(), from }, &g) else { panic!() };
            if gat.take(part, "lap").unwrap() {
                break;
            }
            from = gat.got.len() as u64;
            assert!(rounds < ROUNDS_MOST);
        }
        assert!(rounds >= 2, "{rounds}");
        assert_eq!(gat.got, big);
    }

    #[test]
    fn a_kept_copy_is_served_by_its_name_and_only_a_name() {
        let (t, g) = tree();
        let k = format!("{}.png", crate::store::uuid_v4());
        std::fs::copy(t.top.join("proj/.scratch-x/shot.png"), g.shown.join(&k)).unwrap();
        let kept = |k: String, path: Option<&str>| Sight::Picture { call: None, n: 0, kept: Some(k), path: path.map(str::to_string), measure: false, have: None };
        let SeeMsg::Seen { picture: Some(p), .. } = answer("r", kept(k, None), &g) else { panic!() };
        assert!(!p.stale && !p.data.is_empty());
        let SeeMsg::Seen { why: Some(w), .. } = answer("r", kept("../proj/.env.local".into(), None), &g) else { panic!() };
        assert!(w.contains("not the name of a kept picture"));
        /* Gone: the path it came from, as it is now. */
        let gone = format!("{}.png", crate::store::uuid_v4());
        let SeeMsg::Seen { picture: Some(p), .. } = answer("r", kept(gone.clone(), Some(".scratch-x/shot.png")), &g) else { panic!() };
        assert!(p.stale);
        let SeeMsg::Seen { why: Some(w), .. } = answer("r", kept(gone, None), &g) else { panic!() };
        assert!(w.contains("no longer kept on lap"), "{w}");
    }

    #[test]
    fn a_peer_cannot_slip_a_bad_picture_past_the_check() {
        let p = |data: &str| Pictured { name: "x.png".into(), data: data.into(), ..Pictured::default() };
        assert!(received(&p("!!"), "lap").unwrap_err().contains("do not decode"));
        assert!(received(&p(&crate::base64(b"<html>hi</html>")), "lap").unwrap_err().contains("not one"));
        let huge = crate::base64(&vec![0u8; (crate::show::MAX_PICTURE + 10) as usize]);
        assert!(received(&p(&huge), "lap").unwrap_err().contains("more of"));
        /* What the peer says about the size is not believed: the bytes are. */
        let lying = Pictured { name: "x.png".into(), data: crate::base64(PNG), size: Some((9000, 9000)), ..Pictured::default() };
        assert_eq!(received(&lying, "lap").unwrap().size, Some((2, 3)));
    }

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
        let at = std::env::temp_dir().join(format!("skein-held-{}.pic", crate::store::uuid_v4()));
        let meta = Held { name: "a.png".into(), stamp: Some("3-9".into()), stale: false };
        write_held(&at, &meta, b"\x89PNG\nrest").unwrap();
        let (m, b) = read_held(&at).unwrap();
        assert_eq!(m, meta);
        assert_eq!(b, b"\x89PNG\nrest", "a newline in the bytes is the bytes'");
        let _ = std::fs::remove_file(at);
    }
}
