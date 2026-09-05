//! Handing a link — or a folder — to the rest of the desktop.
//!
//! The transcript renders markdown, and markdown has links. An `<a href>` in
//! this webview would navigate the *studio* to it — the window has no back
//! button and no address bar, so that is a one-way trip out of the app. So a
//! click on a link is a command instead, and the link opens where a link should.
//!
//! `rundll32 url.dll,FileProtocolHandler` rather than `cmd /c start`: `start`
//! goes through the shell, which reads `&` and `^` in a url as its own syntax,
//! and the url here is a string an agent wrote. rundll32 takes it as one
//! argument and hands it to the registered protocol handler — no shell in the
//! middle. The scheme is checked here as well as in `markdown.ts::safeHref`,
//! because a command is reachable from anything holding the IPC, not only from
//! the code path that rendered the link.

/// Is this something we are willing to hand to the shell's protocol handlers?
/// Only the three schemes a transcript can legitimately point at.
fn openable(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    let scheme = lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("mailto:");
    scheme && !url.chars().any(|c| c.is_whitespace() || c.is_control())
}

#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    if !openable(&url) {
        return Err(format!("refusing to open {url}"));
    }

    #[cfg(windows)]
    {
        std::process::Command::new("rundll32.exe")
            .args(["url.dll,FileProtocolHandler", &url])
            .spawn()
            .map_err(|e| format!("could not open {url}: {e}"))?;
        Ok(())
    }

    #[cfg(not(windows))]
    {
        Err("opening links is implemented for windows only".into())
    }
}

/* ── a territory's folder, in the file manager ─────────────────────────────── */

/// Show a folder in Explorer — the parent opened with the folder selected.
///
/// **Not `explorer.exe`, and the difference was measured rather than assumed.**
/// Right-clicking a territory is a gesture you repeat, so the question that
/// decides the mechanism is what the third press does. Probed 2026-09-05 on
/// Windows 11 26200, counting shell windows through `Shell.Application.Windows`
/// before and after, on `C:\atelier\skein`:
///
/// - `explorer.exe <folder>` — a **new window every time**. Two presses, two
///   windows on the same folder; it also opens the folder itself rather than
///   showing it.
/// - `explorer.exe /select,<folder>` — the right *view* (parent, folder
///   selected) and still a **new window every time**.
/// - `SHOpenFolderAndSelectItems` — same view, and the second call **reused the
///   window the first one opened**, same `hwnd`.
///
/// So the reuse the shell is capable of is only reachable through the API, and
/// this is also the industry pattern: Chromium's `platform_util_win.cc` reveals
/// a download this way, which is what Electron's `shell.showItemInFolder` and
/// therefore VS Code's "reveal in file explorer" are underneath. The
/// `explorer.exe /select,` form is Chromium's *fallback* for when the parse
/// fails, and it is deliberately not kept here: a fallback that stacks windows
/// is a fallback whose failure mode is the bug this chose the API to avoid, and
/// there is a plain error message to fall back to instead.
///
/// **Selected in its parent rather than opened.** That is what the API does with
/// no items — the flag-free call takes the *item* and opens whatever contains
/// it — and it is why the menu says "show it" rather than "open it": you are
/// shown the territory, in place, with its neighbours around it. A label
/// promising the folder's contents would be one the reuse cannot pay for.
///
/// A directory and nothing else. The command is reachable from anything holding
/// the IPC, the same argument `openable` above makes about schemes, and "reveal
/// any path on this disk" is a wider promise than the one caller needs. Nothing
/// is executed either way — the shell only navigates a view — so the guard is
/// about keeping the contract narrow rather than about a hazard.
#[tauri::command]
pub async fn show_in_explorer(path: String) -> Result<(), String> {
    /* `async` + `off_main`: the call reaches the shell, and on a cold Explorer
       or a disconnected network root it is not instant. Blocking a synchronous
       command blocks the thread that paints every card on the wall — see the
       note over `crate::off_main`. It also wants a COM apartment of its own,
       which is a thing to do on a thread nobody else is using. */
    crate::off_main(move || reveal(&path)).await?
}

#[cfg(windows)]
fn reveal(path: &str) -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::Win32::System::Com::{
        CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::Common::ITEMIDLIST;
    use windows::Win32::UI::Shell::{SHOpenFolderAndSelectItems, SHParseDisplayName};
    use windows::Win32::UI::WindowsAndMessaging::{AllowSetForegroundWindow, ASFW_ANY};

    if path.is_empty() || !std::path::Path::new(path).is_dir() {
        return Err(format!("{path} is not a folder on this machine"));
    }

    /* S_FALSE means this thread already had an apartment and still owes a
       matching uninitialise, so both successes are ours to undo. An error is
       `RPC_E_CHANGED_MODE` — COM is up in the other model, initialised by
       somebody else — and un-initialising it would be taking away a thing we
       did not put there. */
    let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    let ours = hr.is_ok();

    let out = unsafe {
        let mut pidl: *mut ITEMIDLIST = std::ptr::null_mut();
        /* No attributes asked for and none wanted: the `is_dir` above is this
           function's whole question about what the path is, and asking the
           shell a second time would be two answers to keep in step. */
        SHParseDisplayName(&HSTRING::from(path), None, &mut pidl, 0, None)
            .map_err(|e| format!("the shell could not find {path}: {e}"))
            .and_then(|()| {
                /* Volery is the foreground process — you just clicked a menu
                   row in it — and the window that has to come forward belongs
                   to Explorer, which did not get that click. Windows lets the
                   foreground process hand the privilege on, and this is how you
                   say so; without it a raise from another process is converted
                   into a taskbar flash.
                   Belt and braces rather than a measured fix, and worth saying
                   which: a *new* window comes to the front on its own (probed),
                   and a **reused** one could not be measured here at all —
                   every probe that could hold foreground turned out to be a
                   console whose window belongs to `conhost`/
                   `ApplicationFrameHost` rather than to the process making the
                   call, so it never had the privilege to spend. The call fails
                   harmlessly when unentitled, so this costs nothing if the
                   shell was raising the window anyway. If "show it in explorer"
                   ever reads as doing nothing with a window already open on the
                   parent, this is the line that was not enough, and the table
                   in `.claude/rules/menu.md` is what the alternatives cost. */
                let _ = AllowSetForegroundWindow(ASFW_ANY);
                let r = SHOpenFolderAndSelectItems(pidl, None, 0)
                    .map_err(|e| format!("the shell would not show {path}: {e}"));
                CoTaskMemFree(Some(pidl as *const _));
                r
            })
    };

    if ours {
        unsafe { CoUninitialize() };
    }
    out
}

#[cfg(not(windows))]
fn reveal(_path: &str) -> Result<(), String> {
    Err("showing a folder is implemented for windows only".into())
}

#[cfg(test)]
mod tests {
    use super::openable;

    #[test]
    fn ordinary_web_and_mail_links_are_openable() {
        assert!(openable("https://example.com/a?b=1&c=2"));
        assert!(openable("http://localhost:1420/"));
        assert!(openable("mailto:someone@example.com"));
        assert!(openable("HTTPS://Example.com"));
    }

    #[test]
    fn other_schemes_are_refused() {
        // The front end filters these too; this is the side that can't be skipped.
        assert!(!openable("javascript:alert(1)"));
        assert!(!openable("data:text/html,<script>"));
        assert!(!openable("file:///C:/Windows/System32/calc.exe"));
        assert!(!openable("C:\\Windows\\System32\\calc.exe"));
        assert!(!openable(""));
    }

    #[test]
    fn whitespace_means_it_was_never_one_url() {
        assert!(!openable("https://example.com /x"));
        assert!(!openable("https://example.com\nhttps://evil.example"));
    }
}
