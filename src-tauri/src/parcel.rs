//! Files and folders one card hands another — `send_files` (sink 560a0bbf).
//!
//! The pure half. It decides what a list of paths means as a parcel: which files
//! are in it, which are left out and why, whether it is past a cap, and what the
//! receiving agent reads about it. Then it copies what was decided into a fresh
//! folder. Nothing here knows about cards, the relay or the flyway. `relay.rs`
//! delivers a parcel on this wall and `flyway/` carries one to another.
//!
//! The rules are Lyss's, decided 2026-11-06 over `ask_user`:
//!
//! - **It lands in the receiver's own folder** (`attachments::card_dir`), under
//!   `from-<sender handle>-<n>`. That is outside every repository, nothing there is
//!   ever overwritten, and it goes when the card closes. The receiving agent moves
//!   what it means to keep.
//! - **No click, and secrets are flagged rather than gated.** Walking a folder
//!   leaves out anything secret-shaped. A secret-shaped file named *directly* is
//!   sent, because naming it is the decision, and it is flagged everywhere it
//!   shows. A click would mostly have caught accidents, and the folder rule is
//!   what catches those.
//! - **Inside a git repository, git decides what a folder holds**: tracked plus
//!   untracked-but-not-ignored. Outside one, a plain walk. Never `.git`.
//! - **Links are never followed.** One inside a folder is left out with its
//!   target named. One named directly is refused, and the refusal names what it
//!   points at so the agent can name that instead. A junction that pointed a
//!   folder walk into another repository's `node_modules` is the 2026-10-19 night
//!   in CLAUDE.md, and a parcel is not going to be the next way into it.
//! - **Anywhere on this machine, never a network share** (`show::is_remote`,
//!   asked again of the canonical path, since a junction can land on one).
//! - **Past a cap, the whole parcel is refused** with the count and size said,
//!   never trimmed. An agent cannot tell a trimmed folder from a whole one.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

/// How much one parcel may carry. Two sets: a parcel on this wall is a disk-to-
/// disk copy, and one to another wall is pulled over the flyway a part at a time
/// (`look.rs`), whose per-file ceiling is `look::FILE_MOST`.
#[derive(Debug, Clone, Copy)]
pub struct Caps {
    pub files: usize,
    pub total: u64,
    /// `None` on this wall: the total is the only bound a copy needs.
    pub file: Option<u64>,
}

pub const HERE: Caps = Caps { files: 5_000, total: 500 * MB, file: None };
pub const AFAR: Caps = Caps { files: 5_000, total: 200 * MB, file: Some(24 * MB) };

const MB: u64 = 1024 * 1024;

/// How many left-out lines and top-level lines the manifest spells out before it
/// says "and N more". The manifest is in the receiving agent's context for the
/// rest of its session, and a listing of four thousand ignored files is noise.
const LIST_MOST: usize = 40;

/* What crosses between walls in a request — the types a far wall reads —
   lives in the flyway's core, which a phone links too. Re-exported so every
   `crate::parcel::Carried` reads as before. */
pub use flyway_core::parcel::{Carried, Left, Staged, Top};

/// One file in the parcel.
#[derive(Debug, Clone, PartialEq)]
pub struct Item {
    /// The file on disk, absolute.
    pub src: PathBuf,
    /// Where it lands, relative to the landing folder, `/`-separated. The first
    /// segment is the top-level name (numbered when two collide).
    pub rel: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Parcel {
    pub items: Vec<Item>,
    pub tops: Vec<Top>,
    pub left: Vec<Left>,
    /// Left out past the ones `left` lists — a parcel carried to another wall
    /// sends only the lines its manifest can show.
    pub left_more: usize,
}

impl Parcel {
    pub fn bytes(&self) -> u64 {
        self.items.iter().map(|i| i.bytes).sum()
    }
    /// The secret-shaped files that are in it, by top-level name.
    pub fn secrets(&self) -> Vec<&str> {
        self.tops.iter().filter(|t| t.secret).map(|t| t.name.as_str()).collect()
    }
}

/* ── secret-shaped ───────────────────────────────────────────────────────── */

/// Whether a file name looks like it holds a credential.
///
/// A shape, not a scan: nothing reads the contents, which is the point — a
/// parcel never prints what it carries. Lyss's list, with `id_dsa` added beside
/// its three siblings since a key's algorithm is not what makes it secret.
pub fn secret_shaped(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    /* The hidden spelling counts as the plain one: `.credentials.json` is
       Claude Code's own sign-in, in every `~/.claude` and every managed
       account's folder, and `.git-credentials` is git's store. */
    let bare = n.trim_start_matches('.');
    n.starts_with(".env")
        || [".pem", ".key", ".pfx", ".p12", ".kdbx"].iter().any(|e| n.ends_with(e))
        || ["id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"].iter().any(|p| bare.starts_with(p))
        || bare.starts_with("credentials")
        || bare.starts_with("git-credentials")
}

/* ── sizes ───────────────────────────────────────────────────────────────── */

/// A size as a person writes it: `220 B`, `3.1 KB`, `12.4 MB`.
pub fn size(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    let b = bytes as f64;
    if b < KB {
        format!("{bytes} B")
    } else if b < KB * KB {
        format!("{:.1} KB", b / KB)
    } else if b < KB * KB * KB {
        format!("{:.1} MB", b / KB / KB)
    } else {
        format!("{:.1} GB", b / KB / KB / KB)
    }
}

pub fn count(n: usize, one: &str) -> String {
    if n == 1 {
        format!("1 {one}")
    } else {
        format!("{n} {one}s")
    }
}

/* ── resolving what was named ─────────────────────────────────────────────── */

/// A path with the `\\?\` that `canonicalize` puts on, taken off — the shape a
/// person and an agent both write, and the one `is_remote` reads.
fn plain(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => p.to_path_buf(),
    }
}

fn is_git_dir(p: &Path) -> bool {
    p.components().any(|c| matches!(c, Component::Normal(s) if s.eq_ignore_ascii_case(".git")))
}

/// One named path, resolved: absolute, not a share, not a link, existing.
fn resolve(raw: &str, base: &Path) -> Result<PathBuf, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("an empty path was named".into());
    }
    if crate::show::is_remote(raw) {
        return Err(format!("{raw} is on a network share, and nothing is sent from one"));
    }
    let named = Path::new(raw);
    let joined = if named.is_absolute() { named.to_path_buf() } else { base.join(named) };
    let meta = fs::symlink_metadata(&joined)
        .map_err(|_| format!("{raw} does not exist (looked for {})", joined.display()))?;
    if meta.file_type().is_symlink() || is_junction(&joined) {
        let to = fs::read_link(&joined)
            .map(|t| plain(&t).display().to_string())
            .unwrap_or_else(|_| "somewhere this wall cannot read".into());
        return Err(format!(
            "{raw} is a link to {to}; links are never followed, so name {to} itself"
        ));
    }
    let real = plain(&fs::canonicalize(&joined).map_err(|e| format!("{raw}: {e}"))?);
    if crate::show::is_remote(&real.to_string_lossy()) {
        return Err(format!("{raw} resolves to a network share, and nothing is sent from one"));
    }
    if is_git_dir(&real) {
        return Err(format!("{raw} is inside a .git folder, which is never sent"));
    }
    Ok(real)
}

/// Whether a directory is a junction — a reparse point `is_symlink` does not
/// report on every toolchain. Read off the attribute rather than the type.
#[cfg(windows)]
fn is_junction(p: &Path) -> bool {
    use std::os::windows::fs::MetadataExt;
    const REPARSE: u32 = 0x400;
    fs::symlink_metadata(p).map(|m| m.file_attributes() & REPARSE != 0).unwrap_or(false)
}
#[cfg(not(windows))]
fn is_junction(_: &Path) -> bool {
    false
}

fn is_link(p: &Path, meta: &fs::Metadata) -> bool {
    meta.file_type().is_symlink() || is_junction(p)
}

/// The top-level name a path lands under, numbered past any already taken:
/// `.env`, `.env-2`; `notes.md`, `notes-2.md`. Case-folded, since the folder it
/// lands in is on a case-insensitive disk.
fn top_name(want: &str, taken: &mut HashSet<String>) -> String {
    let mut n = 1;
    loop {
        let name = if n == 1 {
            want.to_string()
        } else {
            match want.rfind('.') {
                Some(dot) if dot > 0 => format!("{}-{n}{}", &want[..dot], &want[dot..]),
                _ => format!("{want}-{n}"),
            }
        };
        if taken.insert(name.to_lowercase()) {
            return name;
        }
        n += 1;
    }
}

/* ── walking a folder ─────────────────────────────────────────────────────── */

/// Running totals, checked as the walk goes so a folder of a million files is
/// refused at the cap rather than after listing all of it.
struct Tally<'a> {
    caps: &'a Caps,
    files: usize,
    bytes: u64,
    over_file: Vec<String>,
    /// Files named directly that also sit inside a folder being walked: the walk
    /// passes over them, since each is its own top-level entry already.
    named: HashSet<String>,
}

/// A path as a key two spellings of one place agree on, on a disk that folds case.
fn key(p: &Path) -> String {
    p.to_string_lossy().to_lowercase().replace('/', "\\")
}

/// Whether `child` is strictly inside `parent`, at a separator.
fn inside(child: &str, parent: &str) -> bool {
    child.len() > parent.len() && child.starts_with(parent) && (parent.ends_with('\\') || child[parent.len()..].starts_with('\\'))
}

impl Tally<'_> {
    fn add(&mut self, rel: &str, bytes: u64) -> Result<(), String> {
        self.files += 1;
        self.bytes += bytes;
        if let Some(most) = self.caps.file {
            if bytes > most {
                self.over_file.push(format!("{rel} ({})", size(bytes)));
            }
        }
        if self.files > self.caps.files {
            return Err(format!(
                "more than {} files — past the cap of {} files a send. Nothing was sent; \
                 name a smaller folder, or the few files that matter",
                self.caps.files, self.caps.files
            ));
        }
        if self.bytes > self.caps.total {
            return Err(format!(
                "more than {} — past the cap of {} a send. Nothing was sent; name a smaller \
                 folder, or the few files that matter",
                size(self.caps.total),
                size(self.caps.total)
            ));
        }
        Ok(())
    }
}

/// What git says a folder holds, relative to it: tracked, and untracked but not
/// ignored. `Ok(None)` when the folder is not in a repository, or git lists
/// nothing — a folder named directly that git ignores whole (a `dist/`, a
/// `memory/` under an ignored root) is walked by hand instead, since naming it
/// was the decision. **An `Err` when it is in a repository and git could not
/// list it** (git missing, `safe.directory`): walking by hand there would send
/// the build output git exists to leave out, so the send is refused instead.
fn git_listing(dir: &Path) -> Result<Option<(Vec<String>, Vec<String>)>, String> {
    let run = |args: &[&str]| -> Result<Vec<String>, String> {
        let mut cmd = Command::new("git");
        cmd.current_dir(dir)
            .args(["--no-optional-locks", "-c", "credential.interactive=false", "-c", "core.quotepath=false"])
            .args(args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .stdin(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        let out = cmd.output().map_err(|e| format!("git could not be run: {e}"))?;
        if !out.status.success() {
            let why = String::from_utf8_lossy(&out.stderr);
            return Err(why.lines().find(|l| !l.trim().is_empty()).unwrap_or("git failed").trim().to_string());
        }
        Ok(
            String::from_utf8_lossy(&out.stdout)
                .split('\0')
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect(),
        )
    };
    let files = match run(&["ls-files", "-co", "--exclude-standard", "-z"]) {
        Ok(f) => f,
        Err(_) if !in_repository(dir) => return Ok(None),
        Err(why) => {
            return Err(format!(
                "{} is in a git repository and git could not list it ({why}), so nothing was \
                 sent — git is what decides which files a repository folder sends",
                dir.display()
            ))
        }
    };
    if files.is_empty() {
        return Ok(None);
    }
    let ignored = run(&["ls-files", "-o", "-i", "--exclude-standard", "--directory", "-z"])
        .unwrap_or_default();
    Ok(Some((files, ignored)))
}

/// Whether `dir` or a folder above it holds a `.git` — a folder or a file, a
/// worktree's `.git` being a file.
fn in_repository(dir: &Path) -> bool {
    dir.ancestors().any(|a| a.join(".git").exists())
}

/// Every file under `root` that goes, git's way or by hand, into `out`, and what
/// stays behind into `left`. `top` is the name it lands under.
fn walk_dir(
    root: &Path,
    top: &str,
    tally: &mut Tally,
    out: &mut Vec<Item>,
    left: &mut Vec<Left>,
) -> Result<(), String> {
    match git_listing(root)? {
        Some((files, ignored)) => walk_git(root, top, &files, &ignored, tally, out, left),
        None => walk_plain(root, root, top, tally, out, left),
    }
}

fn walk_git(
    root: &Path,
    top: &str,
    files: &[String],
    ignored: &[String],
    tally: &mut Tally,
    out: &mut Vec<Item>,
    left: &mut Vec<Left>,
) -> Result<(), String> {
    /* A folder a link sits at is checked once, not once per file under it. Git
       lists through a junction on Windows as though it were a folder, so each
       file's ancestors are asked — the cache keeps that to one stat a folder. */
    let mut linked: HashMap<String, bool> = HashMap::new();
    let mut reported: HashSet<String> = HashSet::new();
    for rel in files {
        let rel = rel.replace('\\', "/");
        let parts: Vec<&str> = rel.split('/').collect();
        let mut under_link = None;
        for i in 1..parts.len() {
            let dir = parts[..i].join("/");
            let is = *linked.entry(dir.clone()).or_insert_with(|| {
                let p = root.join(&dir);
                fs::symlink_metadata(&p).map(|m| is_link(&p, &m)).unwrap_or(false)
            });
            if is {
                under_link = Some(dir);
                break;
            }
        }
        if let Some(dir) = under_link {
            if reported.insert(dir.clone()) {
                left.push(link_left(&root.join(&dir), &format!("{top}/{dir}/")));
            }
            continue;
        }
        let path = root.join(&rel);
        let Ok(meta) = fs::symlink_metadata(&path) else { continue }; // tracked, deleted
        let shown = format!("{top}/{rel}");
        if is_link(&path, &meta) {
            left.push(link_left(&path, &shown));
            continue;
        }
        if meta.is_dir() {
            /* A submodule is listed as its folder. Its files are another
               repository's, and the parcel says so rather than recursing. */
            left.push(Left { path: format!("{shown}/"), why: "a submodule — name it to send it".into() });
            continue;
        }
        if tally.named.contains(&key(&path)) {
            continue;
        }
        if secret_shaped(parts.last().unwrap_or(&"")) {
            left.push(secret_left(&shown));
            continue;
        }
        tally.add(&shown, meta.len())?;
        out.push(Item { src: path, rel: shown, bytes: meta.len() });
    }
    for rel in ignored {
        let rel = rel.replace('\\', "/");
        left.push(Left { path: format!("{top}/{rel}"), why: "ignored by git".into() });
    }
    Ok(())
}

fn walk_plain(
    root: &Path,
    dir: &Path,
    top: &str,
    tally: &mut Tally,
    out: &mut Vec<Item>,
    left: &mut Vec<Left>,
) -> Result<(), String> {
    let mut entries: Vec<_> = fs::read_dir(dir)
        .map_err(|e| format!("could not read {}: {e}", dir.display()))?
        .flatten()
        .collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let rel = path
            .strip_prefix(root)
            .map(|r| r.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| name.clone());
        let shown = format!("{top}/{rel}");
        let Ok(meta) = fs::symlink_metadata(&path) else { continue };
        if name.eq_ignore_ascii_case(".git") {
            left.push(Left {
                path: if meta.is_dir() { format!("{shown}/") } else { shown },
                why: "git's own folder, never sent".into(),
            });
            continue;
        }
        if is_link(&path, &meta) {
            left.push(link_left(&path, &if path.is_dir() { format!("{shown}/") } else { shown }));
            continue;
        }
        if meta.is_dir() {
            walk_plain(root, &path, top, tally, out, left)?;
            continue;
        }
        if tally.named.contains(&key(&path)) {
            continue;
        }
        if secret_shaped(&name) {
            left.push(secret_left(&shown));
            continue;
        }
        tally.add(&shown, meta.len())?;
        out.push(Item { src: path, rel: shown, bytes: meta.len() });
    }
    Ok(())
}

fn link_left(path: &Path, shown: &str) -> Left {
    let to = fs::read_link(path)
        .map(|t| plain(&t).display().to_string())
        .unwrap_or_else(|_| "somewhere unreadable".into());
    Left { path: shown.to_string(), why: format!("a link to {to}, never followed") }
}

fn secret_left(shown: &str) -> Left {
    Left {
        path: shown.to_string(),
        why: "secret-shaped — name it directly to send it".into(),
    }
}

/* ── the whole parcel ─────────────────────────────────────────────────────── */

/// What `paths` means as a parcel. `base` is where a relative path counts from —
/// the sending card's working directory.
///
/// All or nothing: a path that does not resolve, a cap passed, a file too big
/// for the flyway — any of them refuses the whole call, naming what and why,
/// and nothing has been written anywhere yet.
pub fn gather(paths: &[String], base: &Path, caps: &Caps) -> Result<Parcel, String> {
    if paths.is_empty() {
        return Err("no `paths` were named, so nothing was sent".into());
    }
    let mut seen: HashSet<String> = HashSet::new();
    let mut taken: HashSet<String> = HashSet::new();
    let mut tally = Tally { caps, files: 0, bytes: 0, over_file: Vec::new(), named: HashSet::new() };
    let mut parcel = Parcel::default();
    /* Every path resolved before anything is walked, so overlaps are known.
       Named twice is sent once: two copies of one file under two names would
       read as two files to the agent receiving them. */
    let mut named: Vec<(&String, PathBuf, bool)> = Vec::new();
    for raw in paths {
        let real = resolve(raw, base)?;
        if seen.insert(key(&real)) {
            let dir = real.is_dir();
            named.push((raw, real, dir));
        }
    }
    for (raw, real, dir) in &named {
        for (other, outer, outer_dir) in &named {
            if !*outer_dir || !inside(&key(real), &key(outer)) {
                continue;
            }
            if *dir {
                return Err(format!(
                    "{raw} is inside {other}, which is already being sent — name one of them. \
                     Nothing was sent"
                ));
            }
            /* A file named inside a folder being sent: it goes once, as its
               own entry, flagged if it is secret-shaped — the walk passes it. */
            tally.named.insert(key(real));
        }
    }
    for (raw, real, _) in named {
        let want = real
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "drive".into());
        let name = top_name(&want, &mut taken);
        let meta = fs::metadata(&real).map_err(|e| format!("{raw}: {e}"))?;
        if meta.is_dir() {
            let (before_files, before_bytes) = (tally.files, tally.bytes);
            walk_dir(&real, &name, &mut tally, &mut parcel.items, &mut parcel.left)?;
            parcel.tops.push(Top {
                name,
                dir: true,
                files: tally.files - before_files,
                bytes: tally.bytes - before_bytes,
                secret: false,
            });
        } else {
            tally.add(&name, meta.len())?;
            let secret = secret_shaped(&want);
            parcel.items.push(Item { src: real, rel: name.clone(), bytes: meta.len() });
            parcel.tops.push(Top { name, dir: false, files: 1, bytes: meta.len(), secret });
        }
    }
    if !tally.over_file.is_empty() {
        let most = caps.file.map(size).unwrap_or_default();
        let n = tally.over_file.len();
        return Err(format!(
            "{n} {} past the {most} a file can be carried to another wall: {}. Nothing was \
             sent; send the rest, and move the big ones some other way",
            if n == 1 { "file is" } else { "files are" },
            tally.over_file.join(", ")
        ));
    }
    Ok(parcel)
}

/* ── landing it ───────────────────────────────────────────────────────────── */

/// A fresh folder under `dir` for a parcel from `sender`: `from-<handle>-<n>`,
/// the first `n` nobody has. Made here, with `create_dir` rather than
/// `create_dir_all`, so two parcels landing at once cannot both claim one.
pub fn landing(dir: &Path, sender: &str) -> io::Result<PathBuf> {
    fs::create_dir_all(dir)?;
    let handle: String = sender
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(8)
        .collect();
    for n in 1..10_000 {
        let p = dir.join(format!("from-{handle}-{n}"));
        match fs::create_dir(&p) {
            Ok(()) => return Ok(p),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(io::Error::other("ten thousand parcels from one card are already here"))
}

/// `rel` under `into`, or `None` if it would climb out. A parcel's relative
/// names are built by `gather` here, but on another wall they arrive over the
/// wire, and this is where a name that was not ours is caught.
pub fn safe_join(into: &Path, rel: &str) -> Option<PathBuf> {
    let mut out = into.to_path_buf();
    let mut any = false;
    for seg in rel.split(['/', '\\']) {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." || seg.contains(':') || seg.eq_ignore_ascii_case(".git") || rewritten(seg) {
            return None;
        }
        out.push(seg);
        any = true;
    }
    any.then_some(out)
}

/// Whether Windows would write `seg` somewhere other than its name says: a
/// trailing dot or space is dropped (so `a.` lands on `a`), and a device stem —
/// `NUL`, `CON`, `COM1`, with any extension — is a device, not a file. A parcel's
/// own names never look like this; one off the wire might.
fn rewritten(seg: &str) -> bool {
    if seg.ends_with('.') || seg.ends_with(' ') {
        return true;
    }
    let stem = seg.split('.').next().unwrap_or("").trim_end().to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$")
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0')
}

/// Copy every item into `into`, which `landing` made. A failure part way
/// removes the whole folder: half a parcel reads as a whole one to the agent
/// that receives it.
pub fn land(parcel: &Parcel, into: &Path) -> Result<(), String> {
    let copy = || -> Result<(), String> {
        for item in &parcel.items {
            let to = safe_join(into, &item.rel).ok_or_else(|| format!("{} is not a name a file may land under", item.rel))?;
            if let Some(parent) = to.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", item.rel))?;
            }
            /* Asked again at the copy, which follows a link: a file that became
               one since the walk is not followed now either. */
            let now = fs::symlink_metadata(&item.src).map_err(|e| format!("{}: {e}", item.src.display()))?;
            if is_link(&item.src, &now) || !now.is_file() {
                return Err(format!("{} stopped being a plain file while it was being sent", item.rel));
            }
            fs::copy(&item.src, &to).map_err(|e| format!("could not copy {}: {e}", item.src.display()))?;
        }
        Ok(())
    };
    copy().inspect_err(|_| {
        let _ = fs::remove_dir_all(into);
    })
}

/* ── what the receiving agent reads ───────────────────────────────────────── */

/// A message's own words with any line that would read as a parcel's block
/// taken out of that reading — a space put in front of it. An agent passing on
/// a receipt it was given is quoting one, and the plate must be drawn for the
/// parcel that came, never for a quotation (`relay.ts::parcelOf`).
pub fn unmark(text: &str) -> String {
    if !text.contains(PARCEL_MARK) {
        return text.to_string();
    }
    text.split('\n')
        .map(|l| if l.starts_with(PARCEL_MARK) { format!(" {l}") } else { l.to_string() })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The first line of a parcel's block in a relay message. `relay.ts` finds the
/// block by it, so it is the one string both languages must agree on.
pub const PARCEL_MARK: &str = "[skein parcel]";

/// The block appended to the message: where it landed, each named path with its
/// count and size, what was left out and why. One line per entry, `+` sent and
/// `-` left out, fields split on ` · `, so `relay.ts::parcelOf` can draw it as a
/// plate and an agent can read it as a list.
pub fn manifest(parcel: &Parcel, landed: &str) -> String {
    manifest_signed(parcel, landed, None)
}

/// The same manifest, with who it came from said in the header when it was a
/// person on another wall (`docs/PARCEL-DROP.md`).
///
/// This is the one place the *words* carry a parcel's direction. The flyway
/// event knows it, and a transcript read back off disk knows only the text — so
/// a restored session drew a received parcel as *sent with it*, because the
/// direction lived in a field nothing writes down. The field is placed **before**
/// `in`, so a reader that does not know it still reads the landing path exactly
/// as it always did (the path is the rest of the line from `in`).
pub fn manifest_signed(parcel: &Parcel, landed: &str, from: Option<&str>) -> String {
    let signed = from.map(|f| format!(" · from {f}")).unwrap_or_default();
    let mut s = format!(
        "{PARCEL_MARK} {} · {}{signed} · in {landed}\n",
        count(parcel.items.len(), "file"),
        size(parcel.bytes()),
    );
    for top in parcel.tops.iter().take(LIST_MOST) {
        if top.dir {
            s.push_str(&format!("+ {}/ · {} · {}\n", top.name, count(top.files, "file"), size(top.bytes)));
        } else if top.secret {
            s.push_str(&format!("+ {} · {} · secret-shaped, sent because it was named\n", top.name, size(top.bytes)));
        } else {
            s.push_str(&format!("+ {} · {}\n", top.name, size(top.bytes)));
        }
    }
    if parcel.tops.len() > LIST_MOST {
        s.push_str(&format!("+ … · {} more\n", parcel.tops.len() - LIST_MOST));
    }
    for l in parcel.left.iter().take(LIST_MOST) {
        s.push_str(&format!("- {} · {}\n", l.path, l.why));
    }
    let left_total = parcel.left.len() + parcel.left_more;
    if left_total > LIST_MOST {
        s.push_str(&format!("- … · {} more left out\n", left_total - LIST_MOST));
    }
    s.push_str(
        "\n(These are copies, in this card's own folder: they are gone when this card \
         closes. Move or copy what you mean to keep. A secret-shaped file is flagged, \
         never printed — do not print it either.)",
    );
    s
}

/// What the sender's tool result says about the secrets it sent, if any.
pub fn secrets_line(parcel: &Parcel) -> Option<String> {
    let s = parcel.secrets();
    (!s.is_empty()).then(|| {
        format!("{} sent: {}", count(s.len(), "secret-shaped file"), s.join(", "))
    })
}

/* ── the tool ─────────────────────────────────────────────────────────────── */

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

pub const SEND_FILES_TOOL: &str = "send_files";

/// Deferred, with a hint (`ask::roster`). `send`'s loaded description points
/// here in one clause, which is what reaches an agent that would otherwise
/// paste a file's contents into a message.
pub fn send_files_schema() -> Value {
    json!({
        "name": SEND_FILES_TOOL,
        "description":
            "Hand another card files and folders: copies land in that card's own folder \
             and it gets a turn, like `send`, with your message and a list of what \
             arrived. For moving work between cards — a memory folder, a config, a \
             build's output — where pasting contents into `send` would lose the files \
             and fill its context.\n\n\
             `paths` is a list, so several files and folders go in one call; relative \
             ones count from your working directory, and anything on this machine may be \
             named except a network share. A folder in a git repository sends what git \
             tracks plus untracked files it does not ignore; outside one, everything. \
             Links and junctions are never followed, and `.git` never goes. Inside a \
             folder, secret-shaped files (`.env*`, keys, `credentials*`, …) are left out \
             and listed; name one directly and it is sent and flagged. Past 5,000 files \
             or 500 MB (200 MB, 24 MB a file, to a card on another wall) the whole call \
             is refused, never trimmed.\n\n\
             What lands is a copy outside every repository, gone when that card closes — \
             the receiver moves what it keeps. One card per call, by handle or exact \
             title; chat cards neither send nor receive. Never print a secret-shaped \
             file's contents.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "to": {
                    "type": "string",
                    "description": "The card: a handle from `list`, or its exact title."
                },
                "paths": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Files and folders to send, together."
                },
                "message": {
                    "type": "string",
                    "description":
                        "What they are and what to do with them. Arrives above the list."
                },
                "host": {
                    "type": "string",
                    "description":
                        "Optional, as on `send`: only when a handle is on two walls."
                }
            },
            "required": ["to", "paths"]
        }
    })
}

/// The `paths` argument as a list. A lone string is taken as a list of one —
/// the commonest way a model writes "one file" — rather than refused.
pub fn paths_of(args: &Value) -> Vec<String> {
    match args.get("paths") {
        Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).map(str::to_string).collect(),
        Some(Value::String(s)) => vec![s.clone()],
        _ => Vec::new(),
    }
}

/// A parcel with no file in it is refused rather than sent as a list of what
/// was left out — a turn spent on an empty folder is a turn for nothing.
const NOTHING: &str = "there is nothing in it to send — every path named was an empty folder, or \
                       everything in it was left out. Nothing was sent; name a secret-shaped file \
                       directly if that is what you meant to send";

/// The message a parcel arrives under when none was written.
pub const BARE: &str = "Files for you — the list is below.";

/// Where a relative path counts from: the sending card's own working tree.
fn base_of(app: &AppHandle, caller: &str) -> Option<PathBuf> {
    let store = app.state::<crate::store::Store>();
    let conn = store.0.lock().ok()?;
    let me = crate::store::roster_one(&conn, caller)?;
    Some(PathBuf::from(crate::worktree::run_dir(&me.cwd, me.worktree.as_deref())))
}

/// Answer `send_files` for a card on this wall, and do it.
pub fn do_send_files(app: &AppHandle, caller: &str, args: &Value) -> String {
    let paths = paths_of(args);
    if paths.is_empty() {
        return "no `paths` were named, so nothing was sent".into();
    }
    let Some(base) = base_of(app, caller) else {
        return "this card is not on the wall, so it cannot send".into();
    };
    let wall = app.state::<crate::store::Store>().1.clone();
    let mut call = args.clone();
    let message = args
        .get("message")
        .and_then(Value::as_str)
        .filter(|m| !m.trim().is_empty())
        .unwrap_or(BARE);
    call["message"] = Value::String(message.to_string());

    let flagged: std::cell::RefCell<Option<(String, Vec<String>)>> = Default::default();
    let pack = |to: &crate::store::RosterRow| -> Result<(String, String), String> {
        let parcel = gather(&paths, &base, &HERE)?;
        if parcel.items.is_empty() {
            return Err(NOTHING.into());
        }
        let into = landing(&crate::attachments::card_dir(&wall, &to.id), caller)
            .map_err(|e| format!("could not make a folder for it in that card's own folder: {e}"))?;
        land(&parcel, &into)?;
        let block = manifest(&parcel, &into.display().to_string());
        let mut line = format!(
            "{} ({}) copied into {}",
            count(parcel.items.len(), "file"),
            size(parcel.bytes()),
            into.display()
        );
        if let Some(s) = secrets_line(&parcel) {
            line.push_str(&format!(
                "\n{s} — flagged on the parcel and in the chronicle. Do not print them."
            ));
            *flagged.borrow_mut() =
                Some((to.title.clone(), parcel.secrets().iter().map(|s| s.to_string()).collect()));
        }
        line.push_str("\n\n");
        line.push_str(&block);
        Ok((block, line))
    };
    let said = crate::relay::send_with(app, caller, &call, Some(&pack));
    if let Some((to, names)) = flagged.into_inner() {
        flag(app, caller, &to, &names);
    }
    said
}

/// The chronicle row a secret-shaped file sent writes, on the sender's card.
/// A row rather than only a receipt, because the receipt is read by the agent
/// that chose to send it and the row is read by Lyss.
pub(crate) fn flag(app: &AppHandle, caller: &str, to: &str, names: &[String]) {
    crate::chronicle::note_card(
        app,
        caller,
        "note",
        &format!("sent {} to {to}", count(names.len(), "secret-shaped file")),
        &names.join(", "),
    );
}

/* ── to another wall ──────────────────────────────────────────────────────────
 *
 * A parcel for a card on another wall is not copied there by this wall: it is
 * *staged* here (`attachments::stage_out`, the hold a person's prompt files
 * already use) and the receiving wall pulls each stage through the parts
 * transfer a question's files take (`flyway-core/src/look.rs`), then lands it, then hands
 * its card the turn. The sender's call waits for that landing.
 *
 * Stages rather than one, because one pull is bounded by `look::ASK_MOST` and a
 * parcel to another wall may be `AFAR.total`. What crosses in the request is
 * `Carried`: the stage ids, each file's landing name and size in stage order,
 * and the manifest's lines — everything the far wall needs to write the parcel
 * and say what it is, and nothing about where the files sit on this machine.
 */

/// One stage's worth: a pull of its own on the far wall.
const STAGE_BYTES: u64 = 80 * MB;
const STAGE_FILES: usize = 1_000;

/* `Carried` is the flyway's (`flyway_core::parcel`), and the orphan rule
   keeps an inherent `impl` with the crate that defines the type. These two
   read this wall's own caps and name rules, so they are a trait here
   rather than methods there; `crate::parcel::CarriedHere` in scope is all a
   caller needs for `carried.check()` to read as it always did. */
pub trait CarriedHere {
    fn check(&self) -> Result<(), String>;
    fn parcel(&self) -> Parcel;
}

impl CarriedHere for Carried {
    /// Whether what arrived is a parcel this wall will land. The sending wall
    /// checked all of it, and that is a claim: the caps are asked again, and
    /// every name again, here where the files would be written.
    fn check(&self) -> Result<(), String> {
        if self.stages.is_empty() || self.stages.len() > 16 {
            return Err("the parcel named no stage, or too many".into());
        }
        if self.stages.iter().any(|s| !s.id.starts_with("stage-")) {
            return Err("the parcel named a stage this wall cannot pull".into());
        }
        if self.files() > AFAR.files || self.bytes() > AFAR.total {
            return Err(format!(
                "the parcel is {} and {}, past what one send may carry between walls",
                count(self.files(), "file"),
                size(self.bytes())
            ));
        }
        let into = Path::new("parcel");
        let mut seen = HashSet::new();
        for (rel, bytes) in self.stages.iter().flat_map(|s| &s.files) {
            if *bytes > AFAR.file.unwrap_or(u64::MAX) {
                return Err(format!("{rel} is past what one file may be between walls"));
            }
            if safe_join(into, rel).is_none() || !seen.insert(rel.to_lowercase()) {
                return Err(format!("{rel} is not a name a file may land under"));
            }
        }
        Ok(())
    }

    /// The parcel as its manifest reads it.
    fn parcel(&self) -> Parcel {
        Parcel {
            items: self
                .stages
                .iter()
                .flat_map(|s| &s.files)
                .map(|(rel, bytes)| Item { src: PathBuf::new(), rel: rel.clone(), bytes: *bytes })
                .collect(),
            /* Whether a file is secret-shaped is asked again here: the flag
               came off the wire, and an older or careless sender leaving one
               out must not leave this wall's plate and chronicle quiet. */
            tops: self
                .tops
                .iter()
                .map(|t| Top { secret: t.secret || (!t.dir && secret_shaped(&t.name)), ..t.clone() })
                .collect(),
            left: self.left.clone(),
            left_more: self.left_more,
        }
    }
}

/// Stage a gathered parcel for `to` — the card's id on the far wall, which is
/// what that wall asks for it under (`attachments::outbound_args`).
pub fn stage(wall: &Path, host: &str, to: &str, parcel: &Parcel) -> Result<Carried, String> {
    let mut stages: Vec<Staged> = Vec::new();
    let mut batch: Vec<&Item> = Vec::new();
    let mut batch_bytes = 0u64;
    let mut flush = |batch: &mut Vec<&Item>, batch_bytes: &mut u64| -> Result<(), String> {
        if batch.is_empty() {
            return Ok(());
        }
        let files = batch
            .iter()
            .map(|i| (i.rel.clone(), Some(i.src.to_string_lossy().into_owned()), None))
            .collect();
        let id = crate::attachments::stage_out(wall, to, files)?;
        crate::attachments::bind_stage(&id, host)?;
        stages.push(Staged { id, files: batch.iter().map(|i| (i.rel.clone(), i.bytes)).collect() });
        batch.clear();
        *batch_bytes = 0;
        Ok(())
    };
    for item in &parcel.items {
        if !batch.is_empty() && (batch.len() >= STAGE_FILES || batch_bytes + item.bytes > STAGE_BYTES) {
            flush(&mut batch, &mut batch_bytes)?;
        }
        batch_bytes += item.bytes;
        batch.push(item);
    }
    flush(&mut batch, &mut batch_bytes)?;
    if stages.is_empty() {
        return Err(NOTHING.into());
    }
    let shown = parcel.left.len().min(LIST_MOST);
    Ok(Carried {
        stages,
        tops: parcel.tops.clone(),
        left: parcel.left[..shown].to_vec(),
        left_more: parcel.left.len() - shown + parcel.left_more,
    })
}

/// What the sender's receipt says about a parcel the far wall took: the same
/// lines its card was handed, with where it landed said by that wall.
pub fn afar_line(carried: &Carried, host: &str) -> String {
    let p = carried.parcel();
    let mut line = format!(
        "{} ({}) carried to {host} and copied into that card's own folder there",
        count(p.items.len(), "file"),
        size(p.bytes())
    );
    if let Some(s) = secrets_line(&p) {
        line.push_str(&format!(
            "\n{s} — flagged on the parcel and in {host}'s chronicle. Do not print them."
        ));
    }
    line
}

/* ── a person's parcel ───────────────────────────────────────────────────────
 *
 * A person dropping files and folders onto a card gets a parcel, held to the
 * same walk an agent's `send_files` is (docs/PARCEL-DROP.md). There is no card
 * behind the person, so a landing signs as `you` — `from-you-<n>` — and the
 * secret row lands on the receiving card's chronicle, where the files are.
 */

/// One top-level entry of `Summary`, with the source path beside it — the
/// front end re-gathers from these at the send, so the measure and the send
/// must agree on which path each name came from.
#[derive(serde::Serialize)]
pub struct SummaryTop {
    pub name: String,
    pub path: String,
    pub dir: bool,
    pub files: usize,
    pub bytes: u64,
    pub secret: bool,
}

/// What `parcel_measure` answers: the summary the strip above the field draws,
/// gathered against the right caps but never copied. The front end reads the
/// secret-shaped names off `tops`.
#[derive(serde::Serialize)]
pub struct Summary {
    pub files: usize,
    pub bytes: u64,
    pub tops: Vec<SummaryTop>,
    pub left: Vec<Left>,
    pub left_more: usize,
}

/// The resolved, deduplicated top-level source paths, in the order `gather`
/// pushes `tops` — `gather` already validated them, so this only re-reads the
/// same dedup, and nothing can disagree about which name goes with which path.
fn named_paths(paths: &[String], base: &Path) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for raw in paths {
        if let Ok(real) = resolve(raw, base) {
            if seen.insert(key(&real)) {
                out.push(real.to_string_lossy().into_owned());
            }
        }
    }
    out
}

/// What `parcel_local` answers once the files are copied into the card's own
/// folder: the manifest the prompt carries and where it landed.
#[derive(serde::Serialize)]
pub struct LocalLand {
    pub manifest: String,
    pub landed: String,
}

/// Measure what `paths` means as a parcel against `caps`, without copying
/// anything — the strip's summary, asked on drop so a folder's contents, its
/// left-out lines and any secret are answerable while they can still be
/// changed. A refusal (a cap, a link named directly, a share, nothing to send)
/// is the `Err`, and nothing has been written. `caps` is `"afar"` for a card on
/// another wall, anything else is this wall's.
#[tauri::command]
pub async fn parcel_measure(paths: Vec<String>, caps: String) -> Result<Summary, String> {
    let caps = if caps == "afar" { AFAR } else { HERE };
    crate::off_main(move || {
        let base = std::path::PathBuf::new(); // a drop names absolute paths
        let p = gather(&paths, &base, &caps)?;
        if p.items.is_empty() {
            return Err(NOTHING.into());
        }
        let sources = named_paths(&paths, &base);
        let (files, bytes) = (p.items.len(), p.bytes());
        let tops = p
            .tops
            .into_iter()
            .zip(sources)
            .map(|(t, path)| SummaryTop { name: t.name, path, dir: t.dir, files: t.files, bytes: t.bytes, secret: t.secret })
            .collect();
        Ok(Summary { files, bytes, tops, left: p.left, left_more: p.left_more })
    })
    .await?
}

/// A person's parcel to a card on this wall: gather against `HERE`, land it in
/// that card's own folder under `from-you-<n>`, and answer the manifest the
/// front end then sends with the sentence (`Skein.send`). A refusal returns
/// nothing written, and the tiles are handed back to the draft.
#[tauri::command]
pub async fn parcel_local(app: AppHandle, card: String, paths: Vec<String>) -> Result<LocalLand, String> {
    let wall = app.state::<crate::store::Store>().1.clone();
    crate::off_main(move || {
        let base = std::path::PathBuf::new();
        let parcel = gather(&paths, &base, &HERE)?;
        if parcel.items.is_empty() {
            return Err(NOTHING.into());
        }
        let into = landing(&crate::attachments::card_dir(&wall, &card), "you")
            .map_err(|e| format!("could not make a folder in that card's own folder: {e}"))?;
        land(&parcel, &into)?;
        let secrets = parcel.secrets();
        if !secrets.is_empty() {
            crate::chronicle::note_card(
                &app,
                &card,
                "note",
                &format!("received {} from you", count(secrets.len(), "secret-shaped file")),
                &secrets.join(", "),
            );
            /* And the *sending* wall, where the drop was made: a person has no
               card for a row to hang off, so this one is wall-level
               (docs/PARCEL-DROP.md). */
            crate::chronicle::note(
                &app,
                None,
                "volery",
                "note",
                &format!("sent {} to a card here", count(secrets.len(), "secret-shaped file")),
                &secrets.join(", "),
            );
        }
        Ok(LocalLand { manifest: manifest(&parcel, &into.display().to_string()), landed: into.display().to_string() })
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch folder of this test's own, under the system temp.
    fn scratch(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("skein-parcel-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn write(p: &Path, body: &str) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, body).unwrap();
    }

    fn names(p: &Parcel) -> Vec<String> {
        let mut v: Vec<String> = p.items.iter().map(|i| i.rel.clone()).collect();
        v.sort();
        v
    }

    #[test]
    fn secret_shapes() {
        for yes in [".env", ".env.local", ".ENV.production", "server.pem", "tls.key", "a.pfx", "b.p12",
            "vault.kdbx", "id_rsa", "id_ed25519.pub", "id_ecdsa", "credentials", "credentials.json",
            ".credentials.json", ".git-credentials"] {
            assert!(secret_shaped(yes), "{yes} should be secret-shaped");
        }
        for no in ["env.ts", "keyboard.rs", "notes.md", "my.env.md", "CLAUDE.md", "monkey"] {
            assert!(!secret_shaped(no), "{no} should not be secret-shaped");
        }
    }

    #[test]
    fn a_folder_walk_leaves_secrets_out_but_naming_one_sends_it() {
        let d = scratch("secrets");
        write(&d.join("mem/notes.md"), "n");
        write(&d.join("mem/.env"), "SECRET=1");
        write(&d.join("mem/deep/id_rsa"), "k");
        let p = gather(&[d.join("mem").display().to_string()], &d, &HERE).unwrap();
        assert_eq!(names(&p), vec!["mem/notes.md"]);
        let left: Vec<&str> = p.left.iter().map(|l| l.path.as_str()).collect();
        assert!(left.contains(&"mem/.env") && left.contains(&"mem/deep/id_rsa"), "{left:?}");
        assert!(p.secrets().is_empty());

        let p = gather(&[d.join("mem/.env").display().to_string()], &d, &HERE).unwrap();
        assert_eq!(names(&p), vec![".env"]);
        assert_eq!(p.secrets(), vec![".env"]);
        assert!(manifest(&p, "x").contains("secret-shaped, sent because it was named"));
        assert_eq!(secrets_line(&p).unwrap(), "1 secret-shaped file sent: .env");
    }

    #[test]
    fn several_env_files_in_one_call_land_side_by_side() {
        let d = scratch("envs");
        write(&d.join("a/.env"), "1");
        write(&d.join("b/.env"), "2");
        write(&d.join("b/.env.local"), "3");
        let paths = vec![
            d.join("a/.env").display().to_string(),
            "b/.env".to_string(), // relative, counted from base
            d.join("b/.env.local").display().to_string(),
        ];
        let p = gather(&paths, &d, &HERE).unwrap();
        assert_eq!(names(&p), vec![".env", ".env-2", ".env.local"]);
        assert_eq!(secrets_line(&p).unwrap(), "3 secret-shaped files sent: .env, .env-2, .env.local");

        let into = landing(&d.join("land"), "ccec3736abcdef").unwrap();
        assert!(into.ends_with("from-ccec3736-1"));
        land(&p, &into).unwrap();
        assert_eq!(fs::read_to_string(into.join(".env-2")).unwrap(), "2");
        assert!(landing(&d.join("land"), "ccec3736").unwrap().ends_with("from-ccec3736-2"));
    }

    #[test]
    fn a_persons_parcel_lands_under_from_you() {
        let d = scratch("you");
        let into = landing(&d.join("land"), "you").unwrap();
        assert!(into.ends_with("from-you-1"), "{into:?}");
        assert!(landing(&d.join("land"), "you").unwrap().ends_with("from-you-2"));
    }

    #[test]
    fn the_same_path_named_twice_is_sent_once() {
        let d = scratch("twice");
        write(&d.join("x.md"), "x");
        let p = gather(&["x.md".into(), d.join("x.md").display().to_string()], &d, &HERE).unwrap();
        assert_eq!(names(&p), vec!["x.md"]);
    }

    #[test]
    fn a_missing_path_refuses_the_whole_call() {
        let d = scratch("missing");
        write(&d.join("x.md"), "x");
        let e = gather(&["x.md".into(), "nope.md".into()], &d, &HERE).unwrap_err();
        assert!(e.contains("nope.md does not exist"), "{e}");
    }

    #[test]
    fn shares_and_git_folders_are_refused() {
        let d = scratch("refuse");
        assert!(gather(&[r"\\server\share\x".into()], &d, &HERE).unwrap_err().contains("network share"));
        write(&d.join(".git/config"), "c");
        assert!(gather(&[d.join(".git/config").display().to_string()], &d, &HERE)
            .unwrap_err()
            .contains(".git"));
    }

    #[test]
    fn a_plain_walk_never_takes_git_s_own_folder() {
        let d = scratch("plaingit");
        /* A folder that is not a repository, holding one that git cannot read
           (a `.git` with nothing in it): the walk is the plain one, and the
           inner `.git` stays behind. */
        write(&d.join("f/a.txt"), "a");
        write(&d.join("f/y/b.txt"), "b");
        write(&d.join("f/y/.git/junk"), "j");
        let p = gather(&[d.join("f").display().to_string()], &d, &HERE).unwrap();
        assert_eq!(names(&p), vec!["f/a.txt", "f/y/b.txt"]);
        assert!(p.left.iter().any(|l| l.path == "f/y/.git/" && l.why.contains("never sent")), "{:?}", p.left);
    }

    #[test]
    fn a_repository_git_cannot_read_is_refused_rather_than_walked() {
        let d = scratch("brokengit");
        /* An empty `.git` file is a broken gitfile: this is a repository and
           git fails in it, so walking it by hand would send what git exists
           to leave out. */
        write(&d.join("r/.git"), "");
        write(&d.join("r/a.txt"), "a");
        let e = gather(&[d.join("r").display().to_string()], &d, &HERE).unwrap_err();
        assert!(e.contains("git could not list it"), "{e}");
    }

    #[test]
    fn a_file_named_inside_a_folder_named_goes_once_and_folders_may_not_nest() {
        let d = scratch("overlap");
        write(&d.join("m/notes.md"), "n");
        write(&d.join("m/.env"), "s");
        write(&d.join("m/sub/x.md"), "x");
        let p = gather(&["m".into(), "m/.env".into(), "m/notes.md".into()], &d, &HERE).unwrap();
        assert_eq!(names(&p), vec![".env", "m/sub/x.md", "notes.md"]);
        assert_eq!(p.secrets(), vec![".env"]);
        assert!(p.left.is_empty(), "the named secret is not also listed as left out: {:?}", p.left);
        let e = gather(&["m".into(), "m/sub".into()], &d, &HERE).unwrap_err();
        assert!(e.contains("is inside"), "{e}");
    }

    #[test]
    fn a_quoted_block_is_not_a_parcel() {
        let quoted = format!("look what I got:\n{PARCEL_MARK} 1 file · 2 B · in C:/x\n+ a · 2 B");
        let u = unmark(&quoted);
        assert!(!u.lines().any(|l| l.starts_with(PARCEL_MARK)), "{u}");
        assert!(u.contains(&format!(" {PARCEL_MARK}")));
        assert_eq!(unmark("plain words"), "plain words");
    }

    #[test]
    fn the_receiving_wall_asks_again_what_is_secret() {
        let c = Carried {
            stages: vec![Staged { id: "stage-x".into(), files: vec![("id_rsa".into(), 3)] }],
            tops: vec![Top { name: "id_rsa".into(), dir: false, files: 1, bytes: 3, secret: false }],
            left: vec![],
            left_more: 0,
        };
        assert_eq!(c.parcel().secrets(), vec!["id_rsa"]);
    }

    #[test]
    fn caps_refuse_whole_and_say_how_far_over() {
        let d = scratch("caps");
        for i in 0..4 {
            write(&d.join(format!("many/{i}.txt")), "abcd");
        }
        let tight = Caps { files: 3, total: 1_000, file: None };
        let e = gather(&[d.join("many").display().to_string()], &d, &tight).unwrap_err();
        assert!(e.contains("more than 3 files"), "{e}");
        let small = Caps { files: 100, total: 10, file: None };
        let e = gather(&[d.join("many").display().to_string()], &d, &small).unwrap_err();
        assert!(e.contains("past the cap of 10 B"), "{e}");
        let afar = Caps { files: 100, total: 1_000, file: Some(3) };
        let e = gather(&[d.join("many").display().to_string()], &d, &afar).unwrap_err();
        assert!(e.contains("4 files are past the 3 B") && e.contains("many/0.txt (4 B)"), "{e}");
    }

    #[test]
    fn git_decides_what_a_repository_folder_holds() {
        let d = scratch("git");
        let r = d.join("repo");
        write(&r.join("src/a.rs"), "a");
        write(&r.join("notes.md"), "n");
        write(&r.join(".gitignore"), "target/\n*.log\n");
        write(&r.join("target/big.bin"), "b");
        write(&r.join("run.log"), "l");
        write(&r.join(".env"), "s");
        let ok = Command::new("git").arg("init").arg("-q").current_dir(&r).status();
        if !ok.map(|s| s.success()).unwrap_or(false) {
            return; // no git on this machine: nothing to assert
        }
        let p = gather(&[r.display().to_string()], &d, &HERE).unwrap();
        assert_eq!(names(&p), vec!["repo/.gitignore", "repo/notes.md", "repo/src/a.rs"]);
        let why = |path: &str| p.left.iter().find(|l| l.path == path).map(|l| l.why.clone());
        assert_eq!(why("repo/target/").as_deref(), Some("ignored by git"));
        assert_eq!(why("repo/run.log").as_deref(), Some("ignored by git"));
        assert!(why("repo/.env").unwrap().starts_with("secret-shaped"));
    }

    /// A junction, which needs no privilege on Windows where a symlink does.
    #[cfg(windows)]
    fn junction(link: &Path, target: &Path) -> bool {
        Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    #[cfg(windows)]
    #[test]
    fn junctions_are_never_followed_and_one_named_is_refused() {
        let d = scratch("junction");
        write(&d.join("elsewhere/secret-tree/x.txt"), "x");
        write(&d.join("f/a.txt"), "a");
        assert!(junction(&d.join("f").join("nm"), &d.join("elsewhere")), "mklink /J failed");
        let p = gather(&[d.join("f").display().to_string()], &d, &HERE).unwrap();
        assert_eq!(names(&p), vec!["f/a.txt"]);
        let l = p.left.iter().find(|l| l.path == "f/nm/").expect("the junction is listed as left out");
        assert!(l.why.contains("a link to") && l.why.contains("elsewhere"), "{}", l.why);

        let e = gather(&[d.join("f/nm").display().to_string()], &d, &HERE).unwrap_err();
        assert!(e.contains("is a link to") && e.contains("name") && e.contains("elsewhere"), "{e}");
    }

    #[cfg(windows)]
    #[test]
    fn a_junction_inside_a_repository_is_not_walked_through() {
        let d = scratch("gitjunction");
        let r = d.join("repo");
        write(&d.join("other/lib/x.js"), "x");
        write(&r.join("a.txt"), "a");
        if !Command::new("git").args(["init", "-q"]).current_dir(&r).status().map(|s| s.success()).unwrap_or(false) {
            return;
        }
        assert!(junction(&r.join("node_modules"), &d.join("other")));
        let p = gather(&[r.display().to_string()], &d, &HERE).unwrap();
        assert!(!names(&p).iter().any(|n| n.contains("x.js")), "{:?}", names(&p));
    }

    #[test]
    fn a_parcel_for_another_wall_is_staged_and_checked_again_there() {
        let d = scratch("carry");
        write(&d.join("f/a.txt"), "aaaa");
        write(&d.join("f/.env"), "s");
        write(&d.join("k.pem"), "k");
        let paths = vec![d.join("f").display().to_string(), "k.pem".to_string()];
        let p = gather(&paths, &d, &AFAR).unwrap();
        let c = stage(&d, "lab-b", "abcd1234", &p).unwrap();
        assert_eq!((c.files(), c.bytes()), (2, 5));
        c.check().unwrap();
        assert_eq!(c.parcel().secrets(), vec!["k.pem"]);
        assert!(c.left.iter().any(|l| l.path == "f/.env"));

        let back: Carried = serde_json::from_value(serde_json::to_value(&c).unwrap()).unwrap();
        assert_eq!(back, c);

        /* The stage serves those files to the card it was sent to, and only it. */
        let args = crate::attachments::outbound_args("abcd1234", &c.stages[0].id, Some("LAB-B")).unwrap();
        assert_eq!(args["questions"].as_array().unwrap().len(), 2);
        assert!(crate::attachments::outbound_args("someone-else", &c.stages[0].id, Some("lab-b")).is_err());
        /* Bound to the wall it was sent to: another wall that learned the
           stage id, or a caller that cannot say who it is, gets nothing. */
        assert!(crate::attachments::outbound_args("abcd1234", &c.stages[0].id, Some("lab-c")).is_err());
        assert!(crate::attachments::outbound_args("abcd1234", &c.stages[0].id, None).is_err());

        /* What arrives is a claim: names, sizes and stage ids are asked again. */
        let mut bad = c.clone();
        bad.stages[0].files[0].0 = "../outside.txt".into();
        assert!(bad.check().is_err());
        let mut big = c.clone();
        big.stages[0].files[0].1 = AFAR.file.unwrap() + 1;
        assert!(big.check().is_err());
        let mut twice = c.clone();
        let first = twice.stages[0].files[0].clone();
        twice.stages[0].files.push(first);
        assert!(twice.check().is_err());
        let mut forged = c.clone();
        forged.stages[0].id = "ask-1".into();
        assert!(forged.check().is_err());
    }

    #[test]
    fn a_big_parcel_is_split_into_several_pulls() {
        let d = scratch("split");
        for i in 0..(STAGE_FILES + 5) {
            write(&d.join(format!("many/{i}.txt")), "x");
        }
        let p = gather(&[d.join("many").display().to_string()], &d, &AFAR).unwrap();
        let c = stage(&d, "lab-b", "abcd1234", &p).unwrap();
        assert_eq!(c.stages.len(), 2);
        assert_eq!(c.files(), STAGE_FILES + 5);
        c.check().unwrap();
    }

    #[test]
    fn a_parcel_with_nothing_in_it_is_refused() {
        let d = scratch("empty");
        write(&d.join("only/.env"), "s");
        let p = gather(&[d.join("only").display().to_string()], &d, &AFAR).unwrap();
        assert!(p.items.is_empty());
        assert!(stage(&d, "lab-b", "abcd1234", &p).unwrap_err().contains("nothing in it"));
    }

    #[test]
    fn safe_join_keeps_a_name_inside() {
        let d = Path::new("C:/land");
        assert!(safe_join(d, "a/b.txt").is_some());
        assert!(safe_join(d, "console.md").is_some() && safe_join(d, "COM0").is_some() && safe_join(d, "nul-ish/x").is_some());
        for bad in ["../x", "a/../../x", "C:/x", "a/.git/config", "", "/", "a.", "a/b ", "NUL", "con.txt", "x/COM1.md", "lpt9"] {
            assert!(safe_join(d, bad).is_none(), "{bad} should be refused");
        }
    }

    #[test]
    fn the_manifest_reads_as_a_list() {
        let p = Parcel {
            items: vec![],
            tops: vec![
                Top { name: "memory".into(), dir: true, files: 14, bytes: 40 * 1024, secret: false },
                Top { name: "CLAUDE.md".into(), dir: false, files: 1, bytes: 3100, secret: false },
            ],
            left: vec![Left { path: "memory/.env".into(), why: "secret-shaped — name it directly to send it".into() }],
            left_more: 0,
        };
        let m = manifest(&p, "C:/w/from-ab-1");
        let lines: Vec<&str> = m.lines().collect();
        assert_eq!(lines[0], "[skein parcel] 0 files · 0 B · in C:/w/from-ab-1");
        /* A person's parcel from another wall says where it came from, and
           **before** the landing path, so a reader that does not know the field
           still reads the path the same way (`relay.ts::parcelOf`). */
        let signed = manifest_signed(&p, "C:/w/from-you-1", Some("lab-b"));
        assert_eq!(signed.lines().next().unwrap(), "[skein parcel] 0 files · 0 B · from lab-b · in C:/w/from-you-1");
        assert_eq!(lines[1], "+ memory/ · 14 files · 40.0 KB");
        assert_eq!(lines[2], "+ CLAUDE.md · 3.0 KB");
        assert_eq!(lines[3], "- memory/.env · secret-shaped — name it directly to send it");
        assert_eq!(lines[4], "");
    }
}
