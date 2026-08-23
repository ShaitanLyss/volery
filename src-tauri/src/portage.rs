//! The two ends of a layout document: getting one onto the disk, and reading
//! one back off it.
//!
//! Everything *about* a layout is `portage.ts` — what travels, what is left
//! behind, how a re-import avoids doubling the wall, how a territory is rooted
//! somewhere new. This module knows none of that. It exists because the front
//! end cannot touch the filesystem: there is no `tauri-plugin-fs` here, and the
//! dialog plugin picks a path without reading or writing one.
//!
//! Which is also why this is not a general `write_text_file`. A command is
//! reachable from anything holding the IPC — including a card's own agent, which
//! this app spawns with `--dangerously-skip-permissions` — so the narrower the
//! verb, the less there is to think about later. These two take a path the save
//! or open dialog chose, insist on the extension the app writes, and refuse a
//! document larger than any wall could plausibly produce.
//!
//! Both are `async` and both go through `crate::off_main`. That is not a
//! formality: a layout carrying a wall of screenshots is tens of megabytes of
//! base64, the write is one blocking call, and a blocking call on the main
//! thread stops every card on the wall from being painted for as long as it
//! lasts. CLAUDE.md's paragraph on `off_main` is the whole of the reasoning.

use std::path::{Path, PathBuf};

/// The extension a layout is written with. Not a format check — the contents are
/// JSON and `portage.ts` validates them — but it keeps these two commands from
/// being a way to read or overwrite arbitrary files.
const SUFFIX: &str = ".volery.json";

/// Twice what a wall of forty uncompressed screenshots comes to. A ceiling
/// rather than a limit anybody should meet: its job is to turn "the app hung"
/// into a sentence, in the case where the path picked is a DVD image rather than
/// a layout.
const CEILING: u64 = 256 * 1024 * 1024;

fn checked(path: &str) -> Result<PathBuf, String> {
    let p = Path::new(path);
    if !p.is_absolute() {
        return Err(format!("{path} is not a full path"));
    }
    /* Compared lowercase, since a person typing a filename into a save dialog on
       Windows may well capitalise it and the filesystem does not care. */
    if !path.to_ascii_lowercase().ends_with(SUFFIX) {
        return Err(format!("a layout is a {SUFFIX} file"));
    }
    Ok(p.to_path_buf())
}

#[tauri::command]
pub async fn write_layout_file(path: String, text: String) -> Result<(), String> {
    let target = checked(&path)?;
    crate::off_main(move || {
        /* The parent is not created. A save dialog only ever returns a directory
           that exists, and creating one here would mean a typo in a path
           produced a directory tree nobody asked for. */
        std::fs::write(&target, text.as_bytes())
            .map_err(|e| format!("could not write {}: {e}", target.display()))
    })
    .await?
}

#[tauri::command]
pub async fn read_layout_file(path: String) -> Result<String, String> {
    let source = checked(&path)?;
    crate::off_main(move || {
        let size = std::fs::metadata(&source)
            .map_err(|e| format!("could not read {}: {e}", source.display()))?
            .len();
        if size > CEILING {
            return Err(format!(
                "{} is {size} bytes, which is far larger than any layout",
                source.display()
            ));
        }
        /* `read_to_string` rather than reading bytes and decoding here: a
           document this app wrote is UTF-8, and one that is not is a file that
           is not a layout. The error names the file, which is the whole of what
           a person can act on. */
        std::fs::read_to_string(&source)
            .map_err(|e| format!("could not read {}: {e}", source.display()))
    })
    .await?
}

/// Which of these paths are not directories on this machine.
///
/// The whole of how a territory is known to be unrooted. Asked with the paths
/// rather than reading them out of the database, which keeps the SQL in
/// `store.rs` where it belongs and makes this what it actually is: a question
/// about a disk, not about a wall.
///
/// A path that cannot be stated at all — no permission, a disconnected network
/// share — counts as missing, because the answer to "can this territory be
/// worked in" is no either way and a third state would have to be drawn.
///
/// Off the main thread because it is `n` filesystem stats and one of them may be
/// a share that has to time out. That is the case CLAUDE.md's `off_main`
/// paragraph is about: not a slow command, a frozen wall.
#[tauri::command]
pub async fn missing_roots(paths: Vec<String>) -> Result<Vec<String>, String> {
    crate::off_main(move || {
        paths
            .into_iter()
            .filter(|p| !Path::new(p).is_dir())
            .collect::<Vec<String>>()
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_layout_and_only_by_full_path() {
        assert!(checked("C:\\walls\\studio.volery.json").is_ok());
        /* Case, because a save dialog will happily hand back what was typed. */
        assert!(checked("C:\\walls\\Studio.Volery.JSON").is_ok());

        /* The two things this guard is for. */
        assert!(checked("C:\\Windows\\System32\\drivers\\etc\\hosts").is_err());
        assert!(checked("C:\\keys\\id_rsa").is_err());
        /* A relative path resolves against whatever the process's working
           directory happens to be, which is not a place anybody chose. */
        assert!(checked("studio.volery.json").is_err());
        /* The suffix has to be the end of it, not merely present. */
        assert!(checked("C:\\a\\studio.volery.json.exe").is_err());
    }

    /// An accounts document is not a layout, and this is the half of that which
    /// has teeth.
    ///
    /// There are two carried-document formats side by side and they are
    /// deliberately not interchangeable (see `accounts.rs`, and the last section
    /// of `.claude/rules/accounts.md`): a layout is something you can put in a
    /// chat message, and `.volery-accounts.json` holds live bearer tokens.
    /// `accounts.rs` asserts that its reader refuses *this* suffix. The
    /// symmetric case belongs here, and it is the one that costs something if it
    /// ever stops holding — `read_layout_file` hands the file's **text** back to
    /// the front end, so a layout reader that accepted an accounts document
    /// would put three plaintext credentials inside the webview, which is the
    /// one place in this app that renders untrusted content.
    ///
    /// Which is why this is a test rather than a comment. Widening `SUFFIX` to
    /// `.json` — an entirely reasonable-looking convenience — is all it would
    /// take, and nothing else in either module would fail.
    #[test]
    fn an_accounts_document_is_never_read_as_a_layout() {
        assert!(checked(r"C:\walls\mine.volery-accounts.json").is_err());
        assert!(checked(r"C:\walls\Mine.Volery-Accounts.JSON").is_err());
        /* And the near miss, since the suffixes differ by one segment: a layout
           whose name merely mentions accounts is still a layout. */
        assert!(checked(r"C:\walls\accounts.volery.json").is_ok());
    }

    #[test]
    fn the_ceiling_is_a_sentence_rather_than_a_hang() {
        /* Not a behaviour test — there is no 256mb file to point at — but the
           constant is load-bearing enough to be worth pinning: a ceiling below
           a plausible wall would refuse real layouts. Forty screenshots at 2mb
           come to 80mb of file and about 107mb of base64. */
        assert!(CEILING > 128 * 1024 * 1024);
    }
}
