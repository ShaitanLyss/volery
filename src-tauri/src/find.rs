//! Ripgrep, and reading a file so it can be looked at.
//!
//! Three primitives behind the finder panel: the list of a project's files, the
//! lines in it that match something, and the text of one of them. Everything
//! about *which* of them you meant is in `src/lib/finding.ts` — nothing here
//! scores, ranks or fuzzy-matches, and nothing here knows a panel exists.
//!
//! **All three are `async` and go through `off_main`.** A `rg` over an Unreal
//! tree is seconds of work, and a `#[tauri::command]` without `async` runs
//! inline on the thread that also drains the event loop — so a slow grep would
//! not be a slow grep, it would be every card on the wall frozen for exactly as
//! long as it took, with the whole backlog landing at once afterwards. That is
//! the 20s `azdo_runs` freeze in a different hat; see the note over `off_main`
//! in `lib.rs`.
//!
//! **The spawn is the probe**, the same trick `shell.rs` uses to find a
//! PowerShell: rather than walking `PATH` for a name that may be a Store alias
//! stub, each candidate is simply started and the first one that starts wins.
//! There is no fallback to a directory walk of our own. Re-implementing
//! ripgrep's gitignore handling badly would mean a finder that offers you
//! `node_modules` and `Binaries`, which is worse than a finder that says out
//! loud it needs ripgrep installed.

use std::io::{BufRead, BufReader};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;

/* ── bounds ───────────────────────────────────────────────────────────────── */

/// How many paths a project's file list may hold.
///
/// Sent to the front end once per open and filtered there, which is what makes
/// typing instant — so this is a bound on one IPC message and on the array it
/// becomes. 40,000 paths of ~40 characters is about 1.6MB of JSON, which is
/// plenty for anything with a `.git` in it and small enough not to be felt.
///
/// Measured by `examples/find-probe.rs` 2026-08-23 against ripgrep 15.2.0:
/// this repo is **350 paths in 70ms**, and `C:\atelier` — 26,000 files across
/// a dozen projects including an Unreal tree — is **25,957 paths in 181ms**.
/// Both are far enough inside the cap that the once-per-open fetch is the right
/// trade, which is the whole argument for filtering in the front end.
const FILE_CAP: usize = 40_000;

/// How many matching lines one grep answers with.
///
/// The child is killed once this is reached rather than being read to the end:
/// a one-character query against a large tree is millions of lines, and the
/// difference between capping the *answer* and capping the *work* is a panel
/// that stays responsive while you type the second character.
///
/// Measured 2026-08-23 over the 26,000-file `C:\atelier`, which is the pair of
/// numbers this cap exists for. A one-character `e` comes back in **61ms**,
/// capped — it stops as soon as it has enough. A *rare* word over the same tree
/// takes **2.5s**, because nothing lets it stop early: every file has to be read
/// to the end to prove the word is not in it. So the cap does not bound the
/// slow case, and cannot; what bounds that is `GREP_MS`'s debounce and the
/// generation guard in `finder.svelte.ts`, which between them mean one such run
/// per pause in your typing and no stale answer ever drawn. Worth knowing before
/// anyone proposes removing either.
const HIT_CAP: usize = 2_000;

/// How much of one line is kept. A minified bundle is one line of 300KB, and
/// the panel draws the line — so the clip belongs here, at the read, not in the
/// CSS. The same argument `conversation.svelte.ts` makes about `Line.cap`: a cap
/// that only bites at render time is not a memory bound.
const LINE_CAP: usize = 400;

/// How much of a file the viewer will read. Source files are kilobytes; the
/// things that are not are logs and binaries, and neither wants to be in a
/// webview. Reported as truncated rather than refused, because the head of a
/// large log is often exactly what you were looking for.
const VIEW_CAP: usize = 2 * 1024 * 1024;

/* ── finding ripgrep ──────────────────────────────────────────────────────── */

/// Where a `rg` might be, in the order worth trying.
///
/// `PATH` first, because a ripgrep somebody installed on purpose is the one
/// they expect to be used — including its `.ignore` handling and their
/// `RIPGREP_CONFIG_PATH`. VS Code's bundled copy second: it is on most
/// developer machines, it is a known-good build, and finding it means the panel
/// works on a box where nobody has run `winget install ripgrep`.
fn candidates() -> Vec<PathBuf> {
    let mut out = vec![PathBuf::from("rg")];
    #[cfg(windows)]
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        out.push(
            Path::new(&local)
                .join("Programs")
                .join("Microsoft VS Code")
                .join("resources")
                .join("app")
                .join("node_modules")
                .join("@vscode")
                .join("ripgrep")
                .join("bin")
                .join("rg.exe"),
        );
    }
    out
}

/// No console window flashing up behind a GUI app — the same shape `shell.rs`,
/// `actions.rs` and `project.rs` use, and needed here for the same reason: a
/// grep per keystroke would be a black rectangle per keystroke.
#[cfg(windows)]
fn quiet(cmd: &mut Command) -> &mut Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW)
}
#[cfg(not(windows))]
fn quiet(cmd: &mut Command) -> &mut Command {
    cmd
}

/// A `rg` invocation in `root`, or the reason there is not one.
///
/// The probe is the spawn, so this cannot answer "yes" about a binary that
/// then fails to start. The cost of a miss is one failed `CreateProcess`, which
/// is cheaper than the `where.exe` it replaces.
fn ripgrep(root: &str, args: &[&str]) -> Result<std::process::Child, String> {
    let mut last = String::new();
    for exe in candidates() {
        let mut cmd = Command::new(&exe);
        cmd.args(args)
            .current_dir(root)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        quiet(&mut cmd);
        match cmd.spawn() {
            Ok(child) => return Ok(child),
            Err(e) => last = format!("{}: {e}", exe.display()),
        }
    }
    Err(format!(
        "the finder needs ripgrep, and none was found — install it (winget install BurntSushi.ripgrep.MSVC) — {last}"
    ))
}

/* ── what goes back ───────────────────────────────────────────────────────── */

#[derive(Serialize)]
pub struct FileList {
    /// Relative to the root, always with forward slashes. See `slashes`.
    files: Vec<String>,
    /// The cap was reached, so this is a head of the project rather than the
    /// whole of it. Said out loud in the panel: a finder that quietly cannot
    /// see a file is worse than one that says it is only looking at 40,000.
    truncated: bool,
}

#[derive(Serialize)]
pub struct Hit {
    path: String,
    line: u32,
    col: u32,
    text: String,
}

#[derive(Serialize)]
pub struct Hits {
    hits: Vec<Hit>,
    truncated: bool,
    /// Whether the query had to be re-run as a literal because ripgrep would
    /// not take it as a pattern. Reported so the panel can say so — a search
    /// that silently means something other than what you typed is the kind of
    /// thing you only notice when it is wrong.
    literal: bool,
}

#[derive(Serialize)]
pub struct FileText {
    text: String,
    /// Only the head was read. The viewer says so at the bottom.
    truncated: bool,
    /// It is not text at all. The viewer draws nothing rather than a screenful
    /// of replacement characters — which is what `from_utf8_lossy` would
    /// cheerfully hand it.
    binary: bool,
    bytes: u64,
}

/* ── paths ────────────────────────────────────────────────────────────────── */

/// Forward slashes, always.
///
/// ripgrep on Windows answers with `src\lib\finding.ts`, and everything on the
/// other side of the IPC — the fuzzy matcher's word-boundary bonus, the two-tone
/// path drawing, a query somebody typed with a `/` in it — is easier and more
/// predictable in one separator. It is display-and-matching form only: reading
/// the file goes back through `safe_join`, which takes either.
fn slashes(path: &str) -> String {
    path.replace('\\', "/")
}

/// Join a project-relative path onto its root, refusing anything that leaves.
///
/// The finder only ever asks for paths it was itself given by `rg`, so in normal
/// use this can never fail — which is exactly why it is here. A `#[tauri::
/// command]` is reachable from anything holding the IPC and not only from the
/// code path that meant to call it, so "read me any file on this disk" is a
/// capability worth *not* handing out by accident. The same argument `open.rs`
/// makes about checking a url's scheme in Rust as well as in `markdown.ts`.
///
/// `..` is refused rather than resolved, and so is anything absolute or with a
/// drive prefix — resolving would mean `canonicalize`, which needs the file to
/// exist and answers differently for a symlink.
fn safe_join(root: &str, rel: &str) -> Result<PathBuf, String> {
    let rel = Path::new(rel);
    for part in rel.components() {
        match part {
            Component::Normal(_) => {}
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(format!("{} is not inside the project", rel.display()));
            }
        }
    }
    Ok(Path::new(root).join(rel))
}

/// A line, clipped, with its trailing newline gone.
fn clip(line: &str) -> String {
    let line = line.trim_end_matches(['\r', '\n']);
    if line.chars().count() <= LINE_CAP {
        return line.to_string();
    }
    let mut out: String = line.chars().take(LINE_CAP).collect();
    out.push('…');
    out
}

/* ── the file list ────────────────────────────────────────────────────────── */

/// Every file in the project, as ripgrep sees it.
///
/// `--hidden` with `--glob !.git`, which is the pair worth explaining: without
/// `--hidden` a dotfile is invisible, and this repo's whole `.claude/rules/`
/// tree — the thing an agent is most often looking for — would not be findable.
/// With it and nothing else you get several thousand objects out of `.git`,
/// which are not files anybody means. `.gitignore` is otherwise respected,
/// because `node_modules` and `Binaries` in a fuzzy list is what makes a fuzzy
/// list useless.
pub fn list_files(root: &str) -> Result<FileList, String> {
    {
        let mut child = ripgrep(
            &root,
            &["--files", "--hidden", "--glob", "!.git", "--glob", "!.git/**"],
        )?;
        let stdout = child.stdout.take().ok_or("ripgrep gave nothing to read")?;
        let mut files = Vec::new();
        let mut truncated = false;
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if line.is_empty() {
                continue;
            }
            if files.len() >= FILE_CAP {
                truncated = true;
                break;
            }
            files.push(slashes(&line));
        }
        /* Killed rather than waited on when the cap bit — the walk of a large
           tree goes on for a long time after we have stopped reading it, and a
           `wait` here would hold the blocking thread for all of it. */
        let _ = child.kill();
        let _ = child.wait();
        Ok(FileList { files, truncated })
    }
}

/// The command, which is `list_files` off the main thread and nothing else.
#[tauri::command]
pub async fn find_files(root: String) -> Result<FileList, String> {
    crate::off_main(move || list_files(&root)).await?
}

/* ── grep ─────────────────────────────────────────────────────────────────── */

/// Read `rg`'s `path:line:col:text` output into hits.
///
/// Parsed by position rather than by splitting on `:`, because Windows paths
/// have a colon in them (`C:\...`) and lines of source are full of them. The
/// first three colons after the path are the structure; everything after the
/// third is the line, colons and all.
fn read_hits(child: &mut std::process::Child, cap: usize) -> (Vec<Hit>, bool) {
    let Some(stdout) = child.stdout.take() else {
        return (Vec::new(), false);
    };
    let mut hits = Vec::new();
    let mut truncated = false;
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        if hits.len() >= cap {
            truncated = true;
            break;
        }
        let Some(hit) = parse_hit(&line) else { continue };
        hits.push(hit);
    }
    (hits, truncated)
}

/// One `path:line:col:text` line, or nothing if it is not one.
///
/// `rg` is given relative paths to search, so the path here never carries a
/// drive letter — but it can carry anything else a filename can, so the split
/// walks from the left looking for the two numbers rather than assuming where
/// they are.
fn parse_hit(line: &str) -> Option<Hit> {
    /* Walk the colons left to right. The path is everything before the first
       colon that is followed by digits-then-colon-then-digits-then-colon —
       which is the shape `-n --column` guarantees and a filename cannot fake
       without containing a colon, which Windows does not allow. */
    let mut from = 0;
    while let Some(rel) = line[from..].find(':') {
        let at = from + rel;
        let rest = &line[at + 1..];
        if let Some((num, rest)) = rest.split_once(':') {
            if let Ok(no) = num.parse::<u32>() {
                if let Some((colnum, text)) = rest.split_once(':') {
                    if let Ok(col) = colnum.parse::<u32>() {
                        return Some(Hit {
                            path: slashes(&line[..at]),
                            line: no,
                            col,
                            text: clip(text),
                        });
                    }
                }
            }
        }
        from = at + 1;
    }
    None
}

/// Lines in the project that match `query`.
///
/// **The query is a pattern, and falls back to a literal.** Treating it as a
/// regex is what a developer typing into a search box means most of the time
/// (`fn \w+_at`), and it is what ripgrep does by default. But this box is typed
/// into one character at a time, and half the useful queries pass through an
/// invalid state on the way — `foo(` is a parse error, and an empty result is
/// indistinguishable from "nothing matches". So a pattern ripgrep refuses is
/// re-run with `--fixed-strings`, and the panel is told which it got. One retry,
/// on the error path only.
///
/// `--smart-case`: lowercase is case-insensitive, a capital means you meant it.
/// The same rule every editor uses, and the reason there is no case toggle.
pub fn grep(root: &str, query: &str) -> Result<Hits, String> {
    {
        if query.trim().is_empty() {
            return Ok(Hits { hits: Vec::new(), truncated: false, literal: false });
        }

        let common = [
            "--line-number",
            "--column",
            "--no-heading",
            "--color",
            "never",
            "--smart-case",
            "--hidden",
            "--glob",
            "!.git",
            "--glob",
            "!.git/**",
            /* Without this, one minified bundle in the tree answers with a
               single 300KB line and the panel spends its whole budget on it.
               `--max-columns-preview` is the half worth having: probed against
               ripgrep 15.2.0, the cap alone replaces the line with the literal
               text `[Omitted long line with 1 matches]`, which parses as a hit
               and reads as one. With the preview you get the head of the line
               instead, which `clip` shortens again on the way past. */
            "--max-columns",
            "500",
            "--max-columns-preview",
        ];

        let mut args: Vec<&str> = common.to_vec();
        args.push("--regexp");
        args.push(query);

        let mut child = ripgrep(root, &args)?;
        let (hits, truncated) = read_hits(&mut child, HIT_CAP);
        let status = if truncated {
            /* Killed rather than drained: the rest of a one-character query is
               millions of lines nobody asked for. A kill makes the status
               meaningless, which is why the retry below is only ever reached
               when we read the child to the end. */
            let _ = child.kill();
            let _ = child.wait();
            None
        } else {
            child.wait().ok()
        };

        /* Exit 2 is ripgrep's "I could not do what you asked" — a bad pattern
           above all. Exit 1 is the ordinary "no matches". So the retry is
           narrow: only when the pattern itself was refused, and only when there
           was nothing to show for it. */
        let refused = matches!(status.map(|s| s.code()), Some(Some(2))) && hits.is_empty();
        if !refused {
            return Ok(Hits { hits, truncated, literal: false });
        }

        let mut args: Vec<&str> = common.to_vec();
        args.push("--fixed-strings");
        args.push("--regexp");
        args.push(query);
        let mut child = ripgrep(root, &args)?;
        let (hits, truncated) = read_hits(&mut child, HIT_CAP);
        let _ = child.kill();
        let _ = child.wait();
        Ok(Hits { hits, truncated, literal: true })
    }
}

/// The command, which is `grep` off the main thread and nothing else.
#[tauri::command]
pub async fn find_grep(root: String, query: String) -> Result<Hits, String> {
    crate::off_main(move || grep(&root, &query)).await?
}

/* ── reading one ──────────────────────────────────────────────────────────── */

/// The text of one file in the project, for looking at.
///
/// Binary is detected on the bytes rather than trusted to the extension: an
/// extensionless file is normal, and `from_utf8_lossy` over a `.exe` is a
/// screenful of `�` that reads as a rendering bug rather than as "this is not
/// text". A NUL in the head is the same test every diff tool uses.
pub fn read_text(root: &str, path: &str) -> Result<FileText, String> {
    {
        let full = safe_join(root, path)?;
        let bytes = std::fs::metadata(&full).map(|m| m.len()).unwrap_or(0);
        let data = std::fs::read(&full).map_err(|e| format!("could not read {path}: {e}"))?;

        let head = &data[..data.len().min(8192)];
        if head.contains(&0) {
            return Ok(FileText {
                text: String::new(),
                truncated: false,
                binary: true,
                bytes,
            });
        }

        let truncated = data.len() > VIEW_CAP;
        let take = if truncated {
            /* Cut at a line so the last row of the viewer is a whole line
               rather than half of one, and — the reason this is not simply a
               slice — never inside a UTF-8 sequence. A newline is a byte that
               cannot occur inside one, so finding the last of them does both. */
            let head = &data[..VIEW_CAP];
            head.iter()
                .rposition(|&b| b == b'\n')
                .map(|i| i + 1)
                .unwrap_or(VIEW_CAP)
        } else {
            data.len()
        };

        Ok(FileText {
            text: String::from_utf8_lossy(&data[..take]).into_owned(),
            truncated,
            binary: false,
            bytes,
        })
    }
}

/// The command, which is `read_text` off the main thread and nothing else.
#[tauri::command]
pub async fn read_file_text(root: String, path: String) -> Result<FileText, String> {
    crate::off_main(move || read_text(&root, &path)).await?
}

/* -- looking at one that is not text -------------------------------------- */

/// The most of a picture or a film this will carry.
///
/// 16 MB of file, which is about 22 MB of base64 in the webview. Generous for an
/// image and mean for a video, deliberately in both directions: a screenshot or a
/// diagram is what this is for, and a file that has to be *streamed* is one the
/// viewer should decline rather than swallow.
///
/// **A data URL rather than the asset protocol, and that is a containment
/// decision.** `tauri.conf.json` enables `assetProtocol` scoped to
/// `$APPDATA/references/**` -- pinned images, which Volery itself put there.
/// Widening that to reach a project would mean widening it to `**`, since
/// project roots are chosen at runtime and the scope is static configuration --
/// and it would route around `safe_join`, which is the only thing standing
/// between the viewer and every file on this machine. So the bytes come through
/// Rust, past the same join every other read goes through, and the cap is what
/// makes that affordable.
const MEDIA_CAP: u64 = 16 * 1024 * 1024;

/// What the viewer needs to draw a file it cannot read as text.
#[derive(Serialize)]
pub struct FileMedia {
    /// `data:image/png;base64,...`, or empty when `too_large`.
    #[serde(rename = "dataUrl")]
    data_url: String,
    /// `image` or `video` -- which element to draw, decided from the extension
    /// here so the front end needs no second copy of the table.
    kind: String,
    bytes: u64,
    /// Over `MEDIA_CAP`. Said rather than truncated: half a PNG is not a smaller
    /// PNG, it is a broken one, and an `img` that fails to decode looks like a
    /// bug in the viewer rather than like a file that is too big.
    #[serde(rename = "tooLarge")]
    too_large: bool,
}

/// The media type for an extension, and `None` for anything this will not draw.
///
/// An allow-list, and short on purpose. The webview will attempt anything it is
/// handed, so the question is not "what might work" but "what is worth putting
/// on a data URL" -- and every entry here is something the viewer can be relied
/// on to draw rather than to show a broken-image glyph for.
///
/// `svg` is deliberately absent, and it is the interesting omission: an SVG is a
/// document that can carry script, and this app has `csp: null`. It is also
/// *text*, so the existing viewer already opens it and shows exactly what it
/// contains -- which is the more useful reading of a file you are looking at in
/// a code viewer anyway.
pub(crate) fn media_type(path: &str) -> Option<(&'static str, &'static str)> {
    let ext = path.rsplit('.').next()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => ("image/png", "image"),
        "jpg" | "jpeg" => ("image/jpeg", "image"),
        "gif" => ("image/gif", "image"),
        "webp" => ("image/webp", "image"),
        "bmp" => ("image/bmp", "image"),
        "ico" => ("image/x-icon", "image"),
        "avif" => ("image/avif", "image"),
        "mp4" | "m4v" => ("video/mp4", "video"),
        "webm" => ("video/webm", "video"),
        "ogv" => ("video/ogg", "video"),
        "mov" => ("video/quicktime", "video"),
        _ => return None,
    })
}

/// One image or film out of the project, as a data URL.
///
/// The extension decides, unlike `read_text` which sniffs the bytes -- and the
/// two are not inconsistent. Sniffing answers "is this text", which an extension
/// cannot be trusted about because an extensionless file is normal. This answers
/// "which element should draw this", which only the name can say: there is no
/// byte pattern distinguishing a file the webview will render from one it
/// will not.
pub fn read_media(root: &str, path: &str) -> Result<FileMedia, String> {
    let Some((mime, kind)) = media_type(path) else {
        return Err(format!("{path} is not an image or a video this viewer draws"));
    };
    let full = safe_join(root, path)?;
    let bytes = std::fs::metadata(&full).map(|m| m.len()).unwrap_or(0);
    if bytes > MEDIA_CAP {
        return Ok(FileMedia {
            data_url: String::new(),
            kind: kind.to_string(),
            bytes,
            too_large: true,
        });
    }
    let data = std::fs::read(&full).map_err(|e| format!("could not read {path}: {e}"))?;
    Ok(FileMedia {
        data_url: format!("data:{mime};base64,{}", crate::base64(&data)),
        kind: kind.to_string(),
        bytes,
        too_large: false,
    })
}

/// The command, which is `read_media` off the main thread and nothing else.
///
/// `off_main` for the reason every read here has it, and more so: this one
/// base64-encodes up to 16 MB, which is real CPU rather than a file read, and
/// doing it on the thread that paints the wall would freeze every card for as
/// long as it took.
#[tauri::command]
pub async fn read_file_media(root: String, path: String) -> Result<FileMedia, String> {
    crate::off_main(move || read_media(&root, &path)).await?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The table decides by name, and the omissions are the interesting half.
    #[test]
    fn the_viewer_draws_what_it_can_and_declines_the_rest() {
        assert_eq!(media_type("shot.png"), Some(("image/png", "image")));
        assert_eq!(media_type("a/b/c.JPG"), Some(("image/jpeg", "image")));
        assert_eq!(media_type("clip.webm"), Some(("video/webm", "video")));

        /* Text, and already openable -- plus a document that can carry script
           in an app with `csp: null`. See `media_type`. */
        assert_eq!(media_type("icon.svg"), None);
        /* Not something the webview draws. */
        assert_eq!(media_type("notes.md"), None);
        assert_eq!(media_type("archive.zip"), None);
        assert_eq!(media_type("song.mp3"), None);
        /* No extension at all is normal, and is not media. */
        assert_eq!(media_type("Makefile"), None);
    }

    /// A media read goes through the same join every other read does, which
    /// is the whole reason this is a Rust command rather than the asset
    /// protocol.
    #[test]
    fn a_media_read_cannot_climb_out_of_the_project() {
        let root = "C:\\atelier\\skein";
        assert!(read_media(root, "..\\..\\Windows\\shell32.dll").is_err());
        assert!(read_media(root, "C:\\Windows\\explorer.exe").is_err());
        /* And a path inside the project that is simply not media is refused
           by name, before anything is opened. */
        assert!(read_media(root, "src/lib/finding.ts").is_err());
    }

    #[test]
    fn a_relative_path_joins_onto_its_root() {
        let p = safe_join("C:\\atelier\\skein", "src/lib/finding.ts").unwrap();
        assert!(p.ends_with("finding.ts"));
        assert!(p.starts_with("C:\\atelier\\skein"));
    }

    #[test]
    fn nothing_may_climb_out_of_the_project() {
        assert!(safe_join("C:\\atelier\\skein", "..\\..\\Windows\\win.ini").is_err());
        assert!(safe_join("C:\\atelier\\skein", "src/../../secrets").is_err());
        /* Absolute is refused rather than silently winning, which is what
           `Path::join` would do with it. */
        assert!(safe_join("C:\\atelier\\skein", "C:\\Windows\\win.ini").is_err());
        assert!(safe_join("C:\\atelier\\skein", "/etc/passwd").is_err());
    }

    #[test]
    fn a_leading_dot_is_a_path_and_not_an_escape() {
        assert!(safe_join("C:\\atelier\\skein", "./src/lib/finding.ts").is_ok());
        assert!(safe_join("C:\\atelier\\skein", ".claude/rules/finding.md").is_ok());
    }

    #[test]
    fn a_hit_is_split_by_position_and_not_by_colons() {
        let h = parse_hit("src/lib/finding.ts:42:7:  const at = 0;").unwrap();
        assert_eq!(h.path, "src/lib/finding.ts");
        assert_eq!(h.line, 42);
        assert_eq!(h.col, 7);
        assert_eq!(h.text, "  const at = 0;");
    }

    #[test]
    fn the_matched_line_keeps_every_colon_it_had() {
        /* The whole reason this is not `split(':')`: a line of source has more
           colons in it than the structure does. */
        let h = parse_hit("a.ts:1:1:type X = { a: string; b: string };").unwrap();
        assert_eq!(h.text, "type X = { a: string; b: string };");
        assert_eq!(h.line, 1);
    }

    #[test]
    fn a_windows_separator_becomes_a_forward_one() {
        let h = parse_hit("src\\lib\\finding.ts:3:1:x").unwrap();
        assert_eq!(h.path, "src/lib/finding.ts");
    }

    #[test]
    fn what_is_not_a_hit_line_is_not_read_as_one() {
        assert!(parse_hit("").is_none());
        assert!(parse_hit("some plain sentence").is_none());
        // A path and a line number, but no column: not the shape we asked for.
        assert!(parse_hit("src/a.ts:12:hello").is_none());
    }

    #[test]
    fn a_long_line_is_clipped_where_it_is_read() {
        let long = "x".repeat(LINE_CAP * 3);
        let out = clip(&long);
        assert_eq!(out.chars().count(), LINE_CAP + 1, "the ellipsis is the +1");
        assert!(out.ends_with('…'));
    }

    #[test]
    fn a_line_loses_the_newline_it_arrived_with() {
        assert_eq!(clip("hello\r\n"), "hello");
        assert_eq!(clip("hello\n"), "hello");
    }
}
