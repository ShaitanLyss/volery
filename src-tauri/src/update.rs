//! Updating in place, instead of going to GitHub for it.
//!
//! The old way out of a new release was: notice it exists, open the repo,
//! download the installer, close the wall, run the installer, open the wall.
//! Six steps, five of them clerical, and the first one is a thing nobody does
//! reliably — so the version you are running is the version you happened to
//! install, whenever that was.
//!
//! This asks GitHub whether there is a newer tag and, if you say so, downloads
//! the installer and runs it on the way out.
//!
//! ### It is the installer that does the work, and that is the whole design
//!
//! `tauri-plugin-updater` was the obvious answer and is not the one taken. What
//! it buys over this is a minisign signature on a download that comes over HTTPS
//! from the same GitHub either way; what it costs is specific, and there are
//! three of them:
//!
//! - **Its default TLS would fail on the one network this app is used from.**
//!   The default feature is `rustls-tls`, which is `reqwest/rustls-no-provider`
//!   over webpki-roots — and this network runs Netskope interception, so a
//!   bundled Mozilla root set cannot contain the CA that actually signs what
//!   arrives. That is not a guess: it is the failure the note over `ureq` in
//!   `Cargo.toml` was written for, one service over. `ureq` with `native-certs`
//!   reads the Windows store and is already here.
//! - **It brings the async runtime this crate has twice declined.** reqwest 0.13,
//!   tokio, and zip/tar/flate2 behind them. Both `ureq` and `tiny_http` carry a
//!   comment saying they were chosen to avoid exactly that.
//! - **It ends with `std::process::exit(0)`**, which walks straight past
//!   `RunEvent::ExitRequested` — the handler `CLAUDE.md` says everything depends
//!   on, where the supervisor, the servers, the shells and the control token are
//!   all taken down. There is an `on_before_exit` hook to compensate with, and
//!   compensating is worse than not needing to.
//!
//! **And what it buys in smoothness is nothing**, which is the finding that
//! settled it. Read out of `tauri-bundler` 2.9.4's own `installer.nsi`: the
//! installer parses `/P`, `/S`, `/UPDATE`, `/R`, `/NS` and `/ARGS` out of
//! `$CMDLINE` itself, in `.onInit` and `.onInstSuccess`. The plugin's `passive`
//! mode passes `/P /R /UPDATE /ARGS <current args>` — flags, to the same
//! installer, that any caller can pass. So `INSTALL_ARGS` here is the same
//! experience: a progress bar, no questions, and the app back up afterwards.
//!
//! One catch in that template is worth writing down, because getting it wrong
//! looks like a broken restart rather than a missing flag: **`/R` is only read
//! when `/P` or `/S` is also set.** Line 745 of the template, with the comment
//! *"GUI installer has a toggle for the user to (re)start the app"*. Passive and
//! restart go together or neither does anything.
//!
//! ### Rust asks; the wall decides
//!
//! The same split `limits.rs` draws against `limits.ts`, and for its reason: the
//! part that will be argued about is the policy, and an argument is worth having
//! against tests. So this returns what GitHub said and the version it is running,
//! and `update.ts` decides whether that is newer, which asset can actually be
//! driven, and what any of it is called. Nothing here compares a version.
//!
//! ### The installer is launched by the exit handler, not by the button
//!
//! Because quitting can be *refused*. A wall with twenty working cards on it
//! asks before it goes (`quit.rs`), and an installer launched before that
//! question would be overwriting a running exe while the person who said "stay"
//! watches. So the button arms `Arming` and closes the window, the ordinary quit
//! negotiation happens, and `lib.rs` spawns the installer after the supervisor
//! is down — detached, the way `actions::launch_detached` already spawns
//! something meant to outlive the wall.

use serde::Serialize;
use std::io::Read;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};

/// Where the releases are. Off `Cargo.toml`'s `repository`, so the one place
/// this is written down is the place a rename would already be editing.
fn repo() -> Option<String> {
    let url = env!("CARGO_PKG_REPOSITORY").trim_end_matches('/');
    let (_, tail) = url.split_once("github.com/")?;
    let tail = tail.trim_end_matches(".git");
    (tail.matches('/').count() == 1).then(|| tail.to_string())
}

/// Passive, in update mode, and restart when done.
///
/// `/R` is only honoured alongside `/P` or `/S` — see the module note. `/UPDATE`
/// keeps the install directory and skips the shortcut work, which is what makes
/// this an update rather than a second install.
pub const INSTALL_ARGS: [&str; 3] = ["/P", "/UPDATE", "/R"];

/// How long to wait on GitHub before giving up.
///
/// Short, because nothing depends on the answer: an update that is not noticed
/// this launch is noticed the next one. A long wait would only make the first
/// seconds of a launch on a bad network slower for no gain — and it is off the
/// main thread either way (`off_main`), which is the rule a blocking call in a
/// command owes.
const ASK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// A file GitHub is offering on a release.
#[derive(Debug, Clone, Serialize)]
pub struct Asset {
    pub name: String,
    pub url: String,
    pub size: u64,
}

/// What GitHub said about the newest release, and what this build is.
///
/// Both together, in one answer, so the front end never has to ask a second
/// question to find out whether the first one mattered — and so the comparison
/// is made against the version of the binary that actually asked.
#[derive(Debug, Clone, Serialize)]
pub struct Latest {
    /// This build, from `CARGO_PKG_VERSION`.
    pub running: String,
    /// The tag, verbatim. `update.ts` strips the `v`; nothing here reads it.
    pub tag: String,
    pub name: String,
    pub notes: String,
    pub assets: Vec<Asset>,
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(ASK_TIMEOUT)
        .timeout_read(ASK_TIMEOUT)
        .build()
}

/// Ask GitHub about the newest release.
///
/// `None` for a repository this build cannot name, which is a build somebody
/// forked and left the URL off rather than an error worth drawing.
///
/// Unauthenticated, which is 60 requests an hour from one address. That used to
/// be the reason this was asked once a launch; it is now asked whenever the
/// window comes back to the front, which spends at most four an hour and only
/// while somebody is looking at it — see `release.svelte.ts` for the three
/// bounds. No token either: a public repo's releases need none, and an updater
/// that wanted a credential would be an updater nobody could audit.
///
/// `async`, and that is load-bearing rather than stylistic now that it is asked
/// more than once. It is a network request with a read timeout, and a
/// `#[tauri::command]` without `async` runs inline on the thread that drains the
/// event loop — so a synchronous version would stop every card on the wall from
/// being painted for the length of each ask. That is the `azdo_runs` freeze, and
/// CLAUDE.md's paragraph on `off_main` is the whole of it.
#[tauri::command]
pub async fn latest_release() -> Result<Option<Latest>, String> {
    crate::off_main(|| {
        let Some(repo) = repo() else { return Ok(None) };
        let url = format!("https://api.github.com/repos/{repo}/releases/latest");
        let res = agent()
            .get(&url)
            /* GitHub refuses a request with no user agent outright, and the
               documented ask is to name the application. */
            .set("User-Agent", concat!("volery/", env!("CARGO_PKG_VERSION")))
            .set("Accept", "application/vnd.github+json")
            .call()
            .map_err(|e| format!("could not ask GitHub about releases: {e}"))?;
        let body: serde_json::Value = res
            .into_json()
            .map_err(|e| format!("GitHub's answer was not readable: {e}"))?;
        let tag = body["tag_name"].as_str().unwrap_or_default().to_string();
        if tag.is_empty() {
            /* A repository with no releases at all. Not a failure: it is the
               honest state of a fork, and there is nothing to offer. */
            return Ok(None);
        }
        let assets = body["assets"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|it| {
                        Some(Asset {
                            name: it["name"].as_str()?.to_string(),
                            url: it["browser_download_url"].as_str()?.to_string(),
                            size: it["size"].as_u64().unwrap_or(0),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok(Some(Latest {
            running: env!("CARGO_PKG_VERSION").to_string(),
            tag,
            name: body["name"].as_str().unwrap_or_default().to_string(),
            notes: body["body"].as_str().unwrap_or_default().to_string(),
            assets,
        }))
    })
    .await?
}

/// Where a downloaded installer is put.
///
/// Under the studio's own data directory rather than `%TEMP%`, and that is not
/// tidiness. A stray `enum.py` in `%TEMP%` broke every python script run from
/// there on this machine, because Python puts the script's own directory on
/// `sys.path` — the general shape being that a directory everything writes to is
/// a directory anything can be shadowed in. An installer is a thing that will be
/// *executed*, so it goes somewhere this app owns.
fn holding(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no data directory: {e}"))?
        .join("updates");
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not make {}: {e}", dir.display()))?;
    Ok(dir)
}

/// How often the download says how it is going, in bytes.
///
/// A quarter of a megabyte, so a four-megabyte installer reports about sixteen
/// times. Emitting per read would be thousands of events onto the same queue
/// every card is painted from, which is the `off_main` lesson from the other
/// side: the main thread is a shared resource and a progress bar is not worth
/// any of it.
const REPORT_EVERY: u64 = 256 * 1024;

#[derive(Clone, Serialize)]
struct Progress {
    got: u64,
    total: u64,
}

/// Download an installer and answer where it landed.
///
/// The URL is not taken on trust: it has to be a `browser_download_url` on the
/// release this build just asked about, and that is checked by asking again
/// rather than by parsing what was handed in. A command that downloaded and then
/// armed *any* URL an argument named would be a remote-execution primitive with
/// a friendly name, and the front end is not the only thing that can reach a
/// Tauri command — `control.rs` publishes a port.
#[tauri::command]
pub async fn fetch_update(app: AppHandle, url: String) -> Result<String, String> {
    let dir = holding(&app)?;
    crate::off_main(move || {
        let Some(want) = latest_assets()?.into_iter().find(|a| a.url == url) else {
            return Err(
                "that is not a file on the newest release, so it was not downloaded".into(),
            );
        };
        /* One name per version, so a second attempt overwrites rather than
           accumulating — and so a download interrupted half way is replaced by
           the next one instead of being run. */
        let into = dir.join(sane(&want.name));
        let res = agent()
            .get(&want.url)
            .set("User-Agent", concat!("volery/", env!("CARGO_PKG_VERSION")))
            .call()
            .map_err(|e| format!("could not download the installer: {e}"))?;
        let total = res
            .header("Content-Length")
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(want.size);
        let mut body = res.into_reader();
        let mut file = std::fs::File::create(&into)
            .map_err(|e| format!("could not write {}: {e}", into.display()))?;
        let mut buf = [0u8; 64 * 1024];
        let mut got = 0u64;
        let mut said = 0u64;
        loop {
            let n = body
                .read(&mut buf)
                .map_err(|e| format!("the download stopped: {e}"))?;
            if n == 0 {
                break;
            }
            std::io::Write::write_all(&mut file, &buf[..n])
                .map_err(|e| format!("could not write {}: {e}", into.display()))?;
            got += n as u64;
            if got - said >= REPORT_EVERY {
                said = got;
                let _ = app.emit("update:progress", Progress { got, total });
            }
        }
        let _ = app.emit("update:progress", Progress { got, total });
        /* A truncated installer is worse than none: it is an executable that
           will be run. `Content-Length` is the server's own claim about what it
           was sending, so a short read means the connection went, whatever the
           reader thought. */
        if total > 0 && got < total {
            let _ = std::fs::remove_file(&into);
            return Err(format!(
                "the download ended early — {got} bytes of {total}. Nothing was installed."
            ));
        }
        Ok(into.to_string_lossy().to_string())
    })
    .await?
}

/// The release's assets, asked for again rather than remembered.
///
/// Blocking, and called from inside `off_main` only. It exists so `fetch_update`
/// can check a URL against the source of it instead of against a cache the front
/// end could have edited in between.
fn latest_assets() -> Result<Vec<Asset>, String> {
    let Some(repo) = repo() else {
        return Err("this build does not name a repository to update from".into());
    };
    let url = format!("https://api.github.com/repos/{repo}/releases/latest");
    let res = agent()
        .get(&url)
        .set("User-Agent", concat!("volery/", env!("CARGO_PKG_VERSION")))
        .set("Accept", "application/vnd.github+json")
        .call()
        .map_err(|e| format!("could not ask GitHub about releases: {e}"))?;
    let body: serde_json::Value = res
        .into_json()
        .map_err(|e| format!("GitHub's answer was not readable: {e}"))?;
    Ok(body["assets"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|it| {
                    Some(Asset {
                        name: it["name"].as_str()?.to_string(),
                        url: it["browser_download_url"].as_str()?.to_string(),
                        size: it["size"].as_u64().unwrap_or(0),
                    })
                })
                .collect()
        })
        .unwrap_or_default())
}

/// A file name with nothing in it that could mean a directory.
///
/// The name comes off a GitHub release, so it is somebody else's string, and it
/// decides where a file is written and then executed. Separators and dots are
/// what a traversal is made of; everything outside the small set below becomes
/// an underscore rather than being rejected, because a refusal here would be an
/// update blocked by a release title.
fn sane(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let cleaned = cleaned.replace("..", "_");
    if cleaned.is_empty() {
        "installer.exe".into()
    } else {
        cleaned
    }
}

/// The installer to run on the way out, if one has been armed.
///
/// A `Mutex<Option<PathBuf>>` in state rather than a row: it is a decision about
/// *this* exit, and one that survived a restart would install an update the next
/// time the app happened to close.
#[derive(Default)]
pub struct Arming(std::sync::Mutex<Option<PathBuf>>);

impl Arming {
    /// What to run, taken rather than read — the exit handler runs twice in a
    /// clean quit (`ExitRequested` and then `Exit`), and launching an installer
    /// twice is two installers racing for one directory.
    pub fn take(&self) -> Option<PathBuf> {
        self.0.lock().ok().and_then(|mut a| a.take())
    }
}

/// Run this installer once the wall is down.
///
/// Deliberately does not close the window. Quitting can be *refused* — a wall
/// with background work on it asks first (`quit.rs`) — and an installer launched
/// before that question is answered would be rewriting a running exe while
/// somebody who chose to stay watches it happen. So the front end arms this and
/// then closes the window through the ordinary path, and `lib.rs` launches it
/// after the supervisor, the servers and the shells are down.
///
/// The path has to be one this app downloaded, for `fetch_update`'s reason: an
/// arm that took any path would be "run this exe as me, at the moment nothing is
/// watching", which is not a thing a command should offer whatever is asking.
#[tauri::command]
pub fn arm_update(app: AppHandle, path: String) -> Result<(), String> {
    let want = PathBuf::from(&path);
    let dir = holding(&app)?;
    let ok = want.is_file()
        && want.parent() == Some(dir.as_path())
        && want
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("exe"));
    if !ok {
        return Err(format!(
            "{path} is not an installer this app downloaded, so nothing was armed"
        ));
    }
    let arming = app.state::<Arming>();
    let Ok(mut slot) = arming.0.lock() else {
        return Err("could not arm the update".into());
    };
    *slot = Some(want);
    Ok(())
}

/// Launch whatever `arm_update` armed. Called from the exit handler only.
///
/// Detached, and the one other place this app deliberately outlives itself is
/// `actions::launch_detached`, for the same reason said the other way round: the
/// whole point is a process that is still there when this one is not. Failure is
/// swallowed to a log line — the app is already on its way out, there is nothing
/// left to draw a message on, and the installer is still sitting in the data
/// directory to be run by hand.
pub fn run_armed(app: &AppHandle) {
    let Some(path) = app.state::<Arming>().take() else {
        return;
    };
    let args = INSTALL_ARGS.iter().map(|s| s.to_string()).collect();
    match crate::actions::launch_detached(path.to_string_lossy().to_string(), args, String::new()) {
        Ok(pid) => eprintln!("[update] installer started as {pid}"),
        Err(e) => eprintln!("[update] could not start the installer: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The three flags, and why they travel together.
    ///
    /// `/R` alone does nothing: `installer.nsi` only reads it when `/P` or `/S`
    /// is set, which is a missing restart that looks like a broken one.
    #[test]
    fn passive_and_restart_go_together() {
        assert!(INSTALL_ARGS.contains(&"/R"));
        assert!(
            INSTALL_ARGS.contains(&"/P") || INSTALL_ARGS.contains(&"/S"),
            "/R is ignored without one of these"
        );
        /* And update mode, or it re-creates shortcuts and asks for a directory. */
        assert!(INSTALL_ARGS.contains(&"/UPDATE"));
    }

    #[test]
    fn the_repository_is_read_off_the_manifest() {
        /* If this ever answers `None` the feature is silently off, so it is
           worth a test rather than a comment. */
        assert_eq!(repo().as_deref(), Some("ShaitanLyss/volery"));
    }

    /// A name off somebody else's release decides where a file is written and
    /// then executed, so nothing in it may mean a directory.
    #[test]
    fn a_release_asset_cannot_name_a_path() {
        /* The real one, unchanged, because a name that survived nothing would
           be a feature nobody could recognise the download of. */
        assert_eq!(sane("Volery_0.7.0_x64-setup.exe"), "Volery_0.7.0_x64-setup.exe");
        assert_eq!(sane("a/b.exe"), "a_b.exe");
        assert_eq!(sane(""), "installer.exe");
        /* Asserted as properties rather than as exact strings: what matters is
           that nothing survives that a path could be built out of, not which
           underscore stands for which character. */
        for hostile in [
            "../../evil.exe",
            "..\\..\\evil.exe",
            "C:\\windows\\system32\\a.exe",
            "..",
            "....//....//x",
            "sub/dir/x.exe",
        ] {
            let out = sane(hostile);
            assert!(!out.contains(".."), "{hostile} -> {out}");
            assert!(!out.contains('/'), "{hostile} -> {out}");
            assert!(!out.contains('\\'), "{hostile} -> {out}");
            assert!(!out.contains(':'), "{hostile} -> {out}");
        }
    }

    /// Taken, not read: a clean quit runs the exit handler twice.
    #[test]
    fn arming_is_spent_the_first_time_it_is_asked() {
        let a = Arming::default();
        *a.0.lock().unwrap() = Some(PathBuf::from("x.exe"));
        assert_eq!(a.take(), Some(PathBuf::from("x.exe")));
        assert_eq!(a.take(), None);
    }

    #[test]
    fn nothing_armed_is_the_ordinary_case_and_not_a_failure() {
        assert_eq!(Arming::default().take(), None);
    }
}
