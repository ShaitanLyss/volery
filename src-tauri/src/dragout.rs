//! Dragging a picture out of the transcript and into another app — Teams,
//! Outlook, Explorer, the desktop — where it lands as an image file.
//!
//! An HTML5 drag out of WebView2 reaches a native app as nothing it can use, so
//! this is the shell's own drag: a data object for a real file, started with
//! `SHDoDragDrop`. No dependency is added; `dropzone.rs` already speaks OLE the
//! other way and the shell features are on for `open.rs`.
//!
//! Two commands, because the drag must begin while the button is still down and
//! the file has to exist by then. `stage_picture` writes the file when the
//! press lands (the front end remembers what it staged, so a plain click costs
//! one write ever); `drag_file` starts the drag once the pointer has travelled.
//! The file is the picture as the figure drew it — the kept copy's bytes, an
//! svg already rasterised to png by the front end, because Teams cannot use svg.

use std::path::{Path, PathBuf};

use crate::store::Store;

/// Where staged files live, under the studio's own storage.
const DIR: &str = "dragout";
/// How long a staged file is kept. A drop that is still being read by the
/// receiving app when this runs is a day old by definition.
const KEEP_SECS: u64 = 24 * 60 * 60;

fn root(store: &Store) -> PathBuf {
    store.1.join(DIR)
}

/// A file name that is only a name: no separator, no drive, nothing a shell
/// would treat as a path, and never empty.
fn clean_name(name: &str) -> String {
    let base: String = name
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or("")
        .chars()
        .map(|c| if c.is_control() || "<>:\"|?*".contains(c) { '-' } else { c })
        .collect();
    let base = base.trim().trim_matches('.').to_string();
    if base.is_empty() {
        "picture".to_string()
    } else {
        base.chars().take(120).collect()
    }
}

/// Write the picture to a file of its own and hand back the path.
#[tauri::command]
pub async fn stage_picture(
    store: tauri::State<'_, Store>,
    name: String,
    data_url: String,
) -> Result<String, String> {
    let dir = root(&store);
    crate::off_main(move || {
        let b64 = data_url
            .strip_prefix("data:image/")
            .and_then(|r| r.split_once(";base64,"))
            .map(|(_, b)| b)
            .ok_or("that is not a picture this window drew")?;
        let bytes = crate::unbase64(b64).ok_or("the picture's bytes could not be read")?;
        if crate::show::sniff_picture(&bytes).is_none() {
            return Err("those bytes are not a picture".to_string());
        }
        sweep(&dir);
        /* A folder per picture, so the dropped file keeps the name it was
           shown under and two pictures of one name cannot meet. */
        let at = dir.join(crate::store::uuid_v4());
        std::fs::create_dir_all(&at).map_err(|e| format!("could not stage the picture: {e}"))?;
        let file = at.join(clean_name(&name));
        std::fs::write(&file, &bytes).map_err(|e| format!("could not stage the picture: {e}"))?;
        Ok(file.to_string_lossy().into_owned())
    })
    .await?
}

fn sweep(dir: &Path) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let old = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|d| d.as_secs() > KEEP_SECS);
        if old {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

/// Start the shell's drag for a file `stage_picture` wrote. Returns when the
/// drag ends, however it ends.
#[tauri::command]
pub async fn drag_file(
    app: tauri::AppHandle,
    store: tauri::State<'_, Store>,
    path: String,
) -> Result<(), String> {
    let dir = root(&store);
    let file = PathBuf::from(&path);
    /* Only what was staged: this command hands a file to whatever the pointer
       is released over, and a path from the page is not a thing to trust. */
    let inside = file.parent().and_then(|p| p.parent()).is_some_and(|d| d == dir);
    if !inside || !file.is_file() {
        return Err("that is not a staged picture".to_string());
    }
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    app.run_on_main_thread(move || {
        let _ = tx.send(drag(&path));
    })
    .map_err(|e| e.to_string())?;
    crate::off_main(move || rx.recv().unwrap_or(Ok(()))).await?
}

#[cfg(windows)]
fn drag(path: &str) -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::System::Ole::{IDropSource, DROPEFFECT_COPY};
    use windows::Win32::UI::Shell::Common::ITEMIDLIST;
    use windows::Win32::UI::Shell::{SHCreateDataObject, SHDoDragDrop, SHParseDisplayName};
    use windows::Win32::System::Com::IDataObject;

    unsafe {
        let mut pidl: *mut ITEMIDLIST = std::ptr::null_mut();
        SHParseDisplayName(&HSTRING::from(path), None, &mut pidl, 0, None)
            .map_err(|e| format!("the shell could not find the picture: {e}"))?;
        let made: windows::core::Result<IDataObject> =
            SHCreateDataObject(None, Some(&[pidl as *const ITEMIDLIST]), None);
        CoTaskMemFree(Some(pidl as *const _));
        let data = made.map_err(|e| format!("could not offer the picture: {e}"))?;
        /* Copy only: the staged file is ours to keep for the day, and a move
           would have Explorer take it out of the folder under a later drag. */
        let _ = SHDoDragDrop(None, &data, None::<&IDropSource>, DROPEFFECT_COPY);
    }
    Ok(())
}

#[cfg(not(windows))]
fn drag(_path: &str) -> Result<(), String> {
    Err("dragging a picture out is only built for Windows".to_string())
}

#[cfg(test)]
mod tests {
    use super::clean_name;

    #[test]
    fn a_name_is_only_a_name() {
        assert_eq!(clean_name("eos-13-1.png"), "eos-13-1.png");
        assert_eq!(clean_name("..\\..\\evil.png"), "evil.png");
        assert_eq!(clean_name("a:b?.png"), "a-b-.png");
        assert_eq!(clean_name(""), "picture");
        assert_eq!(clean_name("..."), "picture");
    }
}
