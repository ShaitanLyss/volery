//! Files attached to a prompt, on the disk side.
//!
//! `attach.rs` reads a picture for the webview to send inline. Everything else
//! an input can be handed reaches a project card as a **path** (Lyss,
//! 2026-10-16): the agent opens it with its own tools, the way Claude Code
//! inserts a dragged path, so nothing is copied and nothing is spent up front.
//! This module is what that needs from Rust, and it is four small things:
//!
//! - **`inspect_paths`**: what each dropped or pasted path is — a file or a
//!   folder, how big, and whether it is a picture the dock sends inline.
//! - **`clipboard_paths`**: the paths an Explorer copy put on the clipboard
//!   (`CF_HDROP`). A paste event hands the webview a `File` with bytes and no
//!   path, so without this a file copied in Explorer and pasted would be
//!   written out a second time instead of being pointed at, unlike the same file
//!   dragged.
//! - **`write_attachments`**: bytes with no path behind them — a browser drag, a
//!   pasted blob — written into the card's own folder at the send, so a project
//!   card has a path to read.
//! - **`read_document`**: a PDF read in to go inline to a chat card, which has
//!   no filesystem to be pointed into.
//!
//! ## The card's folder, and what bounds it
//!
//! `<wall>/attachments/<card>/<key>/<name>`. Written by the wall that owns the
//! card, at the send — never while a draft is being written, so an unsent draft
//! never touches the disk, which is the rule `attach.md` keeps for pictures.
//!
//! **Kept until the card closes**, not until the message is delivered: delivery
//! is the start of the turn in which the agent reads the file, and a later turn
//! ("now page three of that PDF") reads it again. The close removes the folder
//! (`clear_for`, beside `forget_held` in `close_conversation_record`), and every
//! load sweeps folders whose card is no longer open (`sweep`), which is the
//! backstop for a crash between the two.
//!
//! **And bounded, because this disk runs near-full.** `FILE_MOST` per file
//! (`attach.ts::MAX_FILE_BYTES`, `look.rs`'s own `FILE_MOST`), `WALL_MOST` for
//! everything written for every card on the wall together. Past either the
//! write is refused in words that say where the space went — nothing older is
//! deleted to make room, because a file a card is still reading is not ours to
//! take away.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// The most one written file may be. `attach.ts::MAX_FILE_BYTES`, held equal by
/// `test/attach.test.ts`.
pub const FILE_MOST: u64 = 24 * 1024 * 1024;

/// The most every card's written files may come to together.
pub const WALL_MOST: u64 = 512 * 1024 * 1024;

/// The most a PDF may be when it is read in to go inline.
/// `attach.ts::MAX_DOCUMENT_BYTES`.
pub const DOCUMENT_MOST: u64 = 20 * 1024 * 1024;

/// The folder every card's written files live under.
pub fn root(wall: &Path) -> PathBuf {
    wall.join("attachments")
}

/// One card's folder. The id is a uuid; anything else is filtered to what a
/// folder name may hold, so an id can never climb out of `root`.
pub fn card_dir(wall: &Path, card: &str) -> PathBuf {
    root(wall).join(safe_segment(card))
}

fn safe_segment(s: &str) -> String {
    let kept: String = s
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(64)
        .collect();
    if kept.is_empty() { "_".into() } else { kept }
}

/* ── what a path is ───────────────────────────────────────────────────────── */

/// One dropped or pasted path, as the webview needs it to attach.
#[derive(Serialize, Debug, PartialEq)]
pub struct Inspected {
    pub path: String,
    /// The last component, for the token.
    pub name: String,
    pub dir: bool,
    /// Bytes on disk, for a file.
    pub size: Option<u64>,
    /// A picture the API takes (`attach::media_type_of`), which the dock reads
    /// and sends inline rather than by path — the behaviour it always had.
    pub picture: bool,
    /// A browser drag's file, staged until a send claims it for a card.
    pub staged: bool,
}

/// What each path is. A path that is not there is left out, rather than failing
/// the whole drop: one stale entry on a clipboard must not cost the rest.
#[tauri::command]
pub async fn inspect_paths(
    store: tauri::State<'_, crate::store::Store>,
    paths: Vec<String>,
) -> Result<Vec<Inspected>, String> {
    let wall = store.1.clone();
    crate::off_main(move || {
        paths
            .iter()
            .filter_map(|p| {
                let mut i = inspect(Path::new(p))?;
                i.staged = is_staged(&wall, Path::new(p));
                Some(i)
            })
            .collect()
    })
    .await
}

pub fn inspect(p: &Path) -> Option<Inspected> {
    let meta = std::fs::metadata(p).ok()?;
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| p.to_string_lossy().into_owned());
    Some(Inspected {
        path: p.to_string_lossy().into_owned(),
        name,
        dir: meta.is_dir(),
        size: meta.is_file().then(|| meta.len()),
        picture: meta.is_file() && crate::attach::media_type_of(p).is_some(),
        staged: false,
    })
}

/* ── the clipboard ────────────────────────────────────────────────────────── */

/// The files an Explorer copy put on the clipboard, or nothing.
///
/// Read through OLE rather than the plain clipboard API because that is the
/// feature set this crate already builds the `windows` crate with (`dropzone.rs`
/// reads `CF_HDROP` off a drag the same way), and a new feature recompiles the
/// largest dependency here for one call.
#[tauri::command]
pub async fn clipboard_paths() -> Result<Vec<String>, String> {
    crate::off_main(read_clipboard_paths).await
}

#[cfg(windows)]
fn read_clipboard_paths() -> Vec<String> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use windows::Win32::System::Com::{DVASPECT_CONTENT, FORMATETC, TYMED_HGLOBAL};
    use windows::Win32::System::Ole::{
        OleGetClipboard, OleInitialize, OleUninitialize, ReleaseStgMedium, CF_HDROP,
    };
    use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};
    unsafe {
        /* A pool thread, so an apartment of its own for the length of the read
           and nothing left behind on a thread somebody else will reuse. */
        let inited = OleInitialize(None).is_ok();
        let mut out = Vec::new();
        if let Ok(data) = OleGetClipboard() {
            let format = FORMATETC {
                cfFormat: CF_HDROP.0,
                ptd: std::ptr::null_mut(),
                dwAspect: DVASPECT_CONTENT.0,
                lindex: -1,
                tymed: TYMED_HGLOBAL.0 as u32,
            };
            if let Ok(mut medium) = data.GetData(&format) {
                let hdrop = HDROP(medium.u.hGlobal.0 as _);
                for i in 0..DragQueryFileW(hdrop, 0xFFFF_FFFF, None) {
                    let len = DragQueryFileW(hdrop, i, None) as usize;
                    let mut buf = vec![0u16; len + 1];
                    DragQueryFileW(hdrop, i, Some(&mut buf));
                    out.push(OsString::from_wide(&buf[..len]).to_string_lossy().into_owned());
                }
                ReleaseStgMedium(&mut medium);
            }
        }
        if inited {
            OleUninitialize();
        }
        out
    }
}

/// Off Windows there is no `CF_HDROP`, and a paste is its bytes — which are
/// written to the card's folder at the send like any other pathless file.
#[cfg(not(windows))]
fn read_clipboard_paths() -> Vec<String> {
    Vec::new()
}

/* ── writing bytes for a card ─────────────────────────────────────────────── */

/// One file to write: its name as the draft had it, and its bytes in base64.
#[derive(Deserialize)]
pub struct Writing {
    pub name: String,
    pub data: String,
}

/// Write files for a card and answer the path each was written at, in order.
///
/// All or nothing: a refusal leaves nothing behind, because a prompt sent with
/// two of its three files is the sentence arriving without the thing it is
/// about.
#[tauri::command]
pub async fn write_attachments(
    store: tauri::State<'_, crate::store::Store>,
    card: String,
    files: Vec<Writing>,
) -> Result<Vec<String>, String> {
    let wall = store.1.clone();
    crate::off_main(move || {
        let mut decoded = Vec::with_capacity(files.len());
        for f in &files {
            let bytes = crate::unbase64(&f.data)
                .ok_or_else(|| format!("{} could not be read back from the draft", f.name))?;
            decoded.push((f.name.as_str(), bytes));
        }
        write(&wall, &card, &decoded)
    })
    .await?
}

/// The write itself, with the budget, on a directory a test can point anywhere.
pub fn write(wall: &Path, card: &str, files: &[(&str, Vec<u8>)]) -> Result<Vec<String>, String> {
    let adding: u64 = files.iter().map(|(_, b)| b.len() as u64).sum();
    for (name, bytes) in files {
        if bytes.len() as u64 > FILE_MOST {
            return Err(format!(
                "{name} is {} — the most one attachment may be is {}",
                mb(bytes.len() as u64),
                mb(FILE_MOST)
            ));
        }
    }
    let held = size_of(&root(wall));
    if held + adding > WALL_MOST {
        return Err(format!(
            "attachments written for cards on this machine already come to {} of {}, and they are kept until each card closes — close cards you are done with to make room for {}",
            mb(held),
            mb(WALL_MOST),
            mb(adding)
        ));
    }
    /* One folder per send, so two files of the same name sent a minute apart
       are two files and the first is never overwritten under a turn reading
       it. */
    let dir = card_dir(wall, card).join(fresh_key());
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not make a folder for the attachments: {e}"))?;
    let mut out = Vec::with_capacity(files.len());
    let mut taken: Vec<String> = Vec::new();
    for (name, bytes) in files {
        let mut plain = crate::flyway::look::plain_name(name);
        /* Two attachments named alike in one send are two files. */
        let mut n = 2;
        while taken.contains(&plain.to_lowercase()) {
            plain = numbered(&crate::flyway::look::plain_name(name), n);
            n += 1;
        }
        taken.push(plain.to_lowercase());
        let path = dir.join(&plain);
        if let Err(e) = std::fs::write(&path, bytes) {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(format!("{name} could not be written: {e}"));
        }
        out.push(path.to_string_lossy().into_owned());
    }
    Ok(out)
}

fn numbered(name: &str, n: u32) -> String {
    match name.rfind('.') {
        Some(dot) if dot > 0 => format!("{} {n}{}", &name[..dot], &name[dot..]),
        _ => format!("{name} {n}"),
    }
}

fn fresh_key() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let t = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{t:x}")
}

fn mb(n: u64) -> String {
    if n < 1024 * 1024 {
        format!("{} KB", (n / 1024).max(1))
    } else {
        format!("{} MB", (n + 512 * 1024) / (1024 * 1024))
    }
}

/// Everything under a directory, in bytes. Nothing there is zero.
fn size_of(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    entries
        .flatten()
        .map(|e| match e.file_type() {
            Ok(t) if t.is_dir() => size_of(&e.path()),
            Ok(_) => e.metadata().map(|m| m.len()).unwrap_or(0),
            Err(_) => 0,
        })
        .sum()
}

/* ── a browser's drag: bytes staged until a send claims them ──────────────────
 *
 * A picture dragged out of a browser arrives as bytes with no path
 * (`dropzone.rs`), and the drop has to say *something* the front end can take
 * the way it takes an Explorer drop — a path. So the drag's files are written
 * here, under `_dropped`, the moment they land, and the drop names those paths.
 * They are the wall's until a send claims them for a card (`claim_dropped`
 * moves them into that card's folder, where they live until it closes); one
 * never sent is swept at the next load, since `sweep` keeps only folders of
 * open cards and `_dropped` is not one. Under the same budget as everything
 * written for a card. */

/// Where a drag's files wait to be claimed.
pub fn staging(wall: &Path) -> PathBuf {
    root(wall).join("_dropped")
}

/// Write a drag's files and answer the paths they now have, and what was
/// refused. Never fails the drop: a file that cannot be written is said.
pub fn stage(wall: &Path, files: Vec<crate::dropzone::Virtual>) -> (Vec<String>, Vec<String>) {
    let mut paths = Vec::new();
    let mut refused = Vec::new();
    if files.is_empty() {
        return (paths, refused);
    }
    let dir = staging(wall).join(fresh_key());
    let mut taken: Vec<String> = Vec::new();
    for f in files {
        let size = f.bytes.len() as u64;
        if size > FILE_MOST {
            refused.push(format!("{} is {} — the most one attachment may be is {}", f.name, mb(size), mb(FILE_MOST)));
            continue;
        }
        let held = size_of(&root(wall));
        if held + size > WALL_MOST {
            refused.push(format!(
                "{} was not kept: attachments on this machine already come to {} of {}, and they are kept until each card closes — close cards you are done with",
                f.name,
                mb(held),
                mb(WALL_MOST)
            ));
            continue;
        }
        let mut plain = crate::flyway::look::plain_name(&f.name);
        let mut n = 2;
        while taken.contains(&plain.to_lowercase()) {
            plain = numbered(&crate::flyway::look::plain_name(&f.name), n);
            n += 1;
        }
        taken.push(plain.to_lowercase());
        let path = dir.join(&plain);
        match std::fs::create_dir_all(&dir).and_then(|()| std::fs::write(&path, &f.bytes)) {
            Ok(()) => paths.push(path.to_string_lossy().into_owned()),
            Err(e) => refused.push(format!("{} could not be kept: {e}", f.name)),
        }
    }
    (paths, refused)
}

/// Is this a path a drag's file was staged at?
pub fn is_staged(wall: &Path, path: &Path) -> bool {
    path.starts_with(staging(wall))
}

/// Move staged files into a card's own folder, answering their new paths in
/// order. A path that is not staged is answered as it is — a send never moves
/// a file somebody else owns.
#[tauri::command]
pub async fn claim_dropped(
    store: tauri::State<'_, crate::store::Store>,
    card: String,
    paths: Vec<String>,
) -> Result<Vec<String>, String> {
    let wall = store.1.clone();
    crate::off_main(move || claim(&wall, &card, &paths)).await?
}

pub fn claim(wall: &Path, card: &str, paths: &[String]) -> Result<Vec<String>, String> {
    let dir = card_dir(wall, card).join(fresh_key());
    let mut out = Vec::with_capacity(paths.len());
    for p in paths {
        let from = Path::new(p);
        if !is_staged(wall, from) {
            out.push(p.clone());
            continue;
        }
        let name = from.file_name().ok_or_else(|| format!("{p} names no file"))?;
        std::fs::create_dir_all(&dir).map_err(|e| format!("could not make a folder for the attachments: {e}"))?;
        let to = dir.join(name);
        std::fs::rename(from, &to)
            .or_else(|_| std::fs::copy(from, &to).map(|_| ()).and_then(|()| std::fs::remove_file(from)))
            .map_err(|e| format!("{} could not be moved to its card: {e}", name.to_string_lossy()))?;
        if let Some(parent) = from.parent() {
            let _ = std::fs::remove_dir(parent);
        }
        out.push(to.to_string_lossy().into_owned());
    }
    Ok(out)
}

/* ── files a prompt carries to a card on another wall ─────────────────────────
 *
 * The bytes cross and are written on the wall that owns the card, so the far
 * agent is handed a path on its own machine. Not in the prompt's frame — that
 * is `Pictured`, 7 MB for everything — but pulled by the owning wall in parts
 * (`flyway/look.rs`, proven to 24 MB a file for a question's files), from a
 * stage this wall holds: `stage_outbound` registers the files under an id the
 * prompt names (`attach.ts::manifestEntry`), the owning wall asks for that id
 * the way it would ask for a question (`Link::look_here`), and writes what it
 * gathers into its card's folder (`flyway_fetch`). A file named by path is
 * served from where it is; bytes with no path are written under `_outbound`
 * first. A stage is let go an hour after it was made, and `_outbound` goes at
 * the next load with every other folder that is not an open card's. */

/// The type a prompt's manifest of files rides under in its picture list.
/// `attach.ts::MANIFEST`.
pub const MANIFEST: &str = "application/vnd.volery.files+json";

/// The word a wall announces in `Facts::can` when it pulls a prompt's files
/// (`flyway_fetch`) and serves its own (`outbound_args`).
pub const CAN_FILES: &str = "files";

/// How long a stage is kept for the owning wall to pull from.
const OUTBOUND_KEEP: std::time::Duration = std::time::Duration::from_secs(60 * 60);

struct Outbound {
    card: String,
    files: Vec<(String, String)>,
    dir: Option<PathBuf>,
    at: std::time::Instant,
}

static OUTBOUND: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, Outbound>>> =
    std::sync::LazyLock::new(Default::default);

/// One file a prompt to another wall carries: by its path, or as bytes.
#[derive(Deserialize)]
pub struct Sending {
    pub name: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub data: Option<String>,
}

/// Hold a prompt's files for the owning wall to pull, and answer the stage's id.
/// `card` is the card on *that* wall, which is the only one that may pull them.
#[tauri::command]
pub async fn stage_outbound(
    store: tauri::State<'_, crate::store::Store>,
    card: String,
    files: Vec<Sending>,
) -> Result<String, String> {
    let wall = store.1.clone();
    crate::off_main(move || {
        let mut decoded = Vec::with_capacity(files.len());
        for f in files {
            let bytes = match &f.data {
                Some(d) => Some(crate::unbase64(d).ok_or_else(|| format!("{} could not be read back from the draft", f.name))?),
                None => None,
            };
            decoded.push((f.name, f.path, bytes));
        }
        stage_out(&wall, &card, decoded)
    })
    .await?
}

/// The staging itself, on a directory a test can point anywhere.
pub fn stage_out(wall: &Path, card: &str, files: Vec<(String, Option<String>, Option<Vec<u8>>)>) -> Result<String, String> {
    let stage = format!("stage-{}", fresh_key());
    let dir = root(wall).join("_outbound").join(&stage);
    let mut held = Vec::with_capacity(files.len());
    let mut wrote = false;
    for (name, path, bytes) in files {
        match (path, bytes) {
            (Some(p), _) => {
                let p = PathBuf::from(p);
                let meta = std::fs::metadata(&p).map_err(|e| format!("{name}: {e}"))?;
                if !meta.is_file() {
                    return Err(format!("{name} is a folder, and only files travel to another wall"));
                }
                if meta.len() > FILE_MOST {
                    return Err(format!("{name} is {} — the most one attachment may be is {}", mb(meta.len()), mb(FILE_MOST)));
                }
                let parent = p.parent().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
                let file = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                held.push((parent, file));
            }
            (None, Some(b)) => {
                if b.len() as u64 > FILE_MOST {
                    return Err(format!("{name} is {} — the most one attachment may be is {}", mb(b.len() as u64), mb(FILE_MOST)));
                }
                let plain = crate::flyway::look::plain_name(&name);
                let at = dir.join(held.len().to_string());
                std::fs::create_dir_all(&at).map_err(|e| format!("could not hold {name} for the other wall: {e}"))?;
                std::fs::write(at.join(&plain), &b).map_err(|e| format!("could not hold {name} for the other wall: {e}"))?;
                wrote = true;
                held.push((at.to_string_lossy().into_owned(), plain));
            }
            (None, None) => return Err(format!("{name} came with nothing to send")),
        }
    }
    let mut out = OUTBOUND.lock().map_err(|_| "the outbound files are wedged".to_string())?;
    /* Let go of what nobody pulled within the hour. */
    out.retain(|_, o| {
        let keep = o.at.elapsed() < OUTBOUND_KEEP;
        if !keep {
            if let Some(d) = &o.dir {
                let _ = std::fs::remove_dir_all(d);
            }
        }
        keep
    });
    out.insert(
        stage.clone(),
        Outbound { card: card.to_string(), files: held, dir: wrote.then_some(dir), at: std::time::Instant::now() },
    );
    Ok(stage)
}

/// A stage as a question's arguments, so `look::answer` serves it exactly as
/// it serves a question's files: one site per file, in order.
pub fn outbound_args(card: &str, stage: &str) -> Result<serde_json::Value, String> {
    let out = OUTBOUND.lock().map_err(|_| "the outbound files are wedged".to_string())?;
    match out.get(stage) {
        None => Err("those files are no longer held here — they were sent more than an hour ago".into()),
        Some(o) if o.card != card => Err("those files were sent to another card".into()),
        Some(o) => Ok(serde_json::json!({
            "questions": o.files.iter().map(|(r, n)| serde_json::json!({ "file": { "root": r, "path": n } })).collect::<Vec<_>>()
        })),
    }
}

/* ── reading a PDF in for a chat card ─────────────────────────────────────── */

/// A PDF's bytes in base64, to go inline as a `document` block.
#[tauri::command]
pub async fn read_document(path: String) -> Result<String, String> {
    crate::off_main(move || {
        let p = Path::new(&path);
        let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let meta = std::fs::metadata(p).map_err(|e| format!("{name}: {e}"))?;
        if !meta.is_file() {
            return Err(format!("{name} is not a file"));
        }
        if meta.len() > DOCUMENT_MOST {
            return Err(format!("{name} is {} — a PDF given inline may be at most {}", mb(meta.len()), mb(DOCUMENT_MOST)));
        }
        let bytes = std::fs::read(p).map_err(|e| format!("{name}: {e}"))?;
        if !bytes.starts_with(b"%PDF-") {
            return Err(format!("{name} is not a PDF"));
        }
        Ok(crate::base64(&bytes))
    })
    .await?
}

/* ── going with the card ──────────────────────────────────────────────────── */

/// The card's folder, gone. Called from `close_conversation_record`; a folder
/// that cannot be removed now is the next load's `sweep`.
pub fn clear_for(wall: &Path, card: &str) {
    let dir = card_dir(wall, card);
    if dir.exists() {
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// Every card folder whose card is not open, gone — the backstop for a close
/// that died between taking the card down and taking its folder with it.
/// Off the thread that called it, since removing a folder of files is not a
/// thing to do on the way to painting a wall.
pub fn sweep(wall: &Path, open: &[String]) {
    let root = root(wall);
    let keep: Vec<String> = open.iter().map(|id| safe_segment(id)).collect();
    std::thread::spawn(move || {
        for gone in stale(&root, &keep) {
            let _ = std::fs::remove_dir_all(gone);
        }
    });
}

fn stale(root: &Path, keep: &[String]) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(root) else { return Vec::new() };
    entries
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter(|e| !keep.contains(&e.file_name().to_string_lossy().into_owned()))
        .map(|e| e.path())
        .collect()
}

/// Where every card's written files live, for the front end's hand-back — a
/// held message handed back from a card being closed has its written files
/// read back into the draft before this folder goes.
#[tauri::command]
pub fn attachments_root(store: tauri::State<'_, crate::store::Store>) -> String {
    root(&store.1).to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("volery-attachments-{tag}-{}", fresh_key()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn written_files_land_in_the_cards_own_folder_under_their_own_names() {
        let wall = scratch("write");
        let out = write(&wall, "card-1", &[("notes.txt", b"hello".to_vec()), ("notes.txt", b"again".to_vec())]).unwrap();
        assert_eq!(out.len(), 2);
        assert!(out[0].ends_with("notes.txt"));
        assert!(out[1].ends_with("notes 2.txt"), "two alike in one send are two files: {}", out[1]);
        assert!(Path::new(&out[0]).starts_with(card_dir(&wall, "card-1")));
        assert_eq!(std::fs::read(&out[1]).unwrap(), b"again");
        let _ = std::fs::remove_dir_all(wall);
    }

    #[test]
    fn a_name_cannot_climb_out_and_an_id_cannot_either() {
        let wall = scratch("climb");
        let out = write(&wall, "../../evil", &[("..\\..\\x.txt", b"x".to_vec())]).unwrap();
        assert!(Path::new(&out[0]).starts_with(root(&wall)), "{}", out[0]);
        assert!(out[0].ends_with("x.txt"));
        let _ = std::fs::remove_dir_all(wall);
    }

    #[test]
    fn a_file_past_the_cap_is_refused_and_nothing_is_written() {
        let wall = scratch("cap");
        let big = vec![0u8; (FILE_MOST + 1) as usize];
        let err = write(&wall, "c", &[("ok.txt", b"x".to_vec()), ("big.bin", big)]).unwrap_err();
        assert!(err.contains("big.bin"), "{err}");
        assert!(!card_dir(&wall, "c").exists(), "a refusal leaves nothing behind");
        let _ = std::fs::remove_dir_all(wall);
    }

    #[test]
    fn the_wall_budget_refuses_in_words_that_say_where_the_space_went() {
        let wall = scratch("budget");
        let dir = card_dir(&wall, "old").join("k");
        std::fs::create_dir_all(&dir).unwrap();
        /* A sparse stand-in would not be counted by `len`; a real file of the
           budget is too slow for a test, so the budget is reached by a file of
           the budget's size set with `set_len`, which `metadata.len` reads. */
        let f = std::fs::File::create(dir.join("held.bin")).unwrap();
        f.set_len(WALL_MOST - 10).unwrap();
        drop(f);
        let err = write(&wall, "new", &[("a.txt", vec![0u8; 100])]).unwrap_err();
        assert!(err.contains("kept until each card closes"), "{err}");
        let _ = std::fs::remove_dir_all(wall);
    }

    #[test]
    fn closing_a_card_takes_its_folder_and_no_other() {
        let wall = scratch("clear");
        write(&wall, "a", &[("x", b"1".to_vec())]).unwrap();
        write(&wall, "b", &[("y", b"2".to_vec())]).unwrap();
        clear_for(&wall, "a");
        assert!(!card_dir(&wall, "a").exists());
        assert!(card_dir(&wall, "b").exists());
        let _ = std::fs::remove_dir_all(wall);
    }

    #[test]
    fn the_sweep_finds_only_folders_of_cards_no_longer_open() {
        let wall = scratch("sweep");
        write(&wall, "open-1", &[("x", b"1".to_vec())]).unwrap();
        write(&wall, "closed-1", &[("y", b"2".to_vec())]).unwrap();
        let gone = stale(&root(&wall), &["open-1".into()]);
        assert_eq!(gone, vec![card_dir(&wall, "closed-1")]);
        let _ = std::fs::remove_dir_all(wall);
    }

    #[test]
    fn a_path_says_what_it_is() {
        let wall = scratch("inspect");
        let pic = wall.join("shot.PNG");
        std::fs::write(&pic, b"png").unwrap();
        let doc = wall.join("r.pdf");
        std::fs::write(&doc, b"%PDF-").unwrap();
        let i = inspect(&pic).unwrap();
        assert!(i.picture && !i.dir && i.size == Some(3));
        let d = inspect(&doc).unwrap();
        assert!(!d.picture && d.name == "r.pdf");
        let f = inspect(&wall).unwrap();
        assert!(f.dir && f.size.is_none() && !f.picture);
        assert!(inspect(&wall.join("missing")).is_none());
        let _ = std::fs::remove_dir_all(wall);
    }

    /// The caps are stated on both sides of the boundary and must not drift.
    #[test]
    fn the_caps_are_the_ones_attach_ts_holds() {
        let ts = include_str!("../../src/lib/attach.ts");
        assert!(ts.contains("export const MAX_FILE_BYTES = 24 * 1024 * 1024;"));
        assert!(ts.contains("export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;"));
        assert_eq!(FILE_MOST, 24 * 1024 * 1024);
        assert_eq!(DOCUMENT_MOST, 20 * 1024 * 1024);
    }

    #[test]
    fn a_browser_drag_is_staged_then_claimed_into_its_card() {
        let wall = scratch("stage");
        let (paths, refused) = stage(
            &wall,
            vec![crate::dropzone::Virtual { name: "pic.png".into(), bytes: b"png".to_vec() }],
        );
        assert!(refused.is_empty());
        assert!(is_staged(&wall, Path::new(&paths[0])));
        let elsewhere = wall.join("mine.txt");
        std::fs::write(&elsewhere, b"x").unwrap();
        let moved = claim(&wall, "c", &[paths[0].clone(), elsewhere.to_string_lossy().into_owned()]).unwrap();
        assert!(Path::new(&moved[0]).starts_with(card_dir(&wall, "c")), "{}", moved[0]);
        assert_eq!(std::fs::read(&moved[0]).unwrap(), b"png");
        assert!(!Path::new(&paths[0]).exists());
        /* A file that was not staged is somebody's own, and is never moved. */
        assert_eq!(moved[1], elsewhere.to_string_lossy());
        assert!(elsewhere.exists());
        /* And an unclaimed drag goes at the next load. */
        assert!(stale(&root(&wall), &["c".into()]).contains(&staging(&wall)) || !staging(&wall).exists());
        let _ = std::fs::remove_dir_all(wall);
    }

    #[test]
    fn a_staged_file_past_the_cap_is_said_not_written() {
        let wall = scratch("stagecap");
        let (paths, refused) = stage(
            &wall,
            vec![crate::dropzone::Virtual { name: "huge.bin".into(), bytes: vec![0u8; (FILE_MOST + 1) as usize] }],
        );
        assert!(paths.is_empty());
        assert!(refused[0].contains("huge.bin"));
        let _ = std::fs::remove_dir_all(wall);
    }

    #[test]
    fn a_stage_serves_its_files_to_the_card_they_were_sent_to_and_no_other() {
        let wall = scratch("out");
        let on_disk = wall.join("report.pdf");
        std::fs::write(&on_disk, b"%PDF-").unwrap();
        let stage = stage_out(
            &wall,
            "far-card",
            vec![
                ("report.pdf".into(), Some(on_disk.to_string_lossy().into_owned()), None),
                ("drag.png".into(), None, Some(b"png".to_vec())),
            ],
        )
        .unwrap();
        let args = outbound_args("far-card", &stage).unwrap();
        let files = crate::flyway::look::files_in(&args);
        assert_eq!(files[0], (wall.to_string_lossy().into_owned(), "report.pdf".to_string()));
        assert_eq!(std::fs::read(Path::new(&files[1].0).join(&files[1].1)).unwrap(), b"png");
        assert!(outbound_args("another-card", &stage).is_err());
        assert!(outbound_args("far-card", "stage-nope").is_err());
        let _ = std::fs::remove_dir_all(wall);
    }

    #[test]
    fn a_folder_does_not_travel() {
        let wall = scratch("outdir");
        let err = stage_out(&wall, "c", vec![("src".into(), Some(wall.to_string_lossy().into_owned()), None)]).unwrap_err();
        assert!(err.contains("folder"), "{err}");
        let _ = std::fs::remove_dir_all(wall);
    }
}
