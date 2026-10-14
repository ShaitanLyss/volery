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
//! something meant to outlive the wall. Beside it goes a watchdog that starts
//! the wall again if the installer's own restart never happens (`run_armed`).
//!
//! ### And a card can ask for it (`UPDATE_TOOL`)
//!
//! The button fires when the window comes to the front, which is exactly what a
//! laptop left running at home never gets — so the machine that most needed
//! updating was the one nobody was in front of, and twice a card did it by hand
//! and reached for WMI to outlive its own wall (sink `549f6a63`). The tool is the
//! button's tail with a question in front of it: resolve, download, check, ask
//! the person through a confirmation that travels the flyway, and on their yes
//! arm and close. Nothing a card spawns has to outlive the card; the installer is
//! still Volery's, launched from the exit handler. See `.claude/rules/update.md`.

use serde::Serialize;
use serde_json::{json, Value};
use std::io::Read;
use std::path::{Path, PathBuf};
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
#[derive(Debug, Clone, Serialize, PartialEq)]
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

/// The newest tag and this build's version, and nothing else.
///
/// The cheap half of the question. See `latest_tag`.
#[derive(Debug, Clone, Serialize)]
pub struct Peek {
    pub running: String,
    pub tag: String,
}

/// The tag out of the `Location` github.com answers a `/releases/latest` with.
///
/// Pure so it can be asserted, because it reads somebody else's header and
/// decides what version this app thinks exists. Anything that is not exactly a
/// release-tag URL for a repository is `None` — the doubt rule this whole module
/// is built on, one layer down: a `Location` we cannot read is silence, not a
/// guess.
fn tag_from_location(location: &str) -> Option<String> {
    let (_, tag) = location.trim_end_matches('/').split_once("/releases/tag/")?;
    /* One segment. A `Location` carrying a path after the tag is not a shape
       github.com produces, and following it would be inventing a version. */
    if tag.is_empty() || tag.contains('/') {
        return None;
    }
    Some(tag.to_string())
}

/// Is there a newer tag? Asked of **github.com**, not of the API, because the
/// API's budget on a corporate network is not this app's to spend.
///
/// `GET https://api.github.com/...` is 60 requests an hour **from one address**,
/// and on the network this was written for that address is a Netskope egress
/// shared with an entire company. Measured 2026-08-28 from `163.116.215.93`:
/// 42 of the 60 already spent, minutes into the window, by nobody here. So the
/// old cadence was not merely slow — a quarter of an hour between asks, of a
/// bucket somebody else keeps emptying, and **every failure of it is silence by
/// design**. An update that never appears and a rate limit look identical.
///
/// Conditional requests do not buy a way out, which was worth measuring rather
/// than assuming: with `If-None-Match`, a `304 Not Modified` still decrements
/// `X-RateLimit-Remaining` (probed 2026-08-28, 20 → 19 → 18). ETags save
/// bandwidth here and no headroom at all.
///
/// What does buy a way out is that **github.com is not api.github.com**.
/// `HEAD /{repo}/releases/latest` answers `302` with
/// `Location: .../releases/tag/v0.14.4` and `Cache-Control: no-cache`, and it
/// spends none of the API budget — probed the same day, three of them in a row
/// left `used` at 44. So the tag is free to ask for as often as anyone likes,
/// and `latest_release` is spent only once something has actually changed.
///
/// Not a replacement for it: this says *what version*, and nothing about whether
/// there is an installer that can be driven. The offer still needs the API, and
/// still refuses when the asset is not there.
#[tauri::command]
pub async fn latest_tag() -> Result<Option<Peek>, String> {
    crate::off_main(|| {
        let Some(repo) = repo() else { return Ok(None) };
        let url = format!("https://github.com/{repo}/releases/latest");

        /* `redirects(0)` is the entire point: the answer *is* the redirect, and
           an agent that followed it would fetch a page of HTML to learn nothing
           the header already said. */
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(ASK_TIMEOUT)
            .timeout_read(ASK_TIMEOUT)
            .tls_config(crate::forge::tls_config())
            .redirects(0)
            .build();

        let res = agent
            .head(&url)
            .set("User-Agent", concat!("volery/", env!("CARGO_PKG_VERSION")))
            .call();

        /* ureq hands back 3xx as `Ok` when redirects are off and 4xx/5xx as
           `Error::Status`, and both carry a response — so the header is read the
           same way from either arm rather than only from the happy one. */
        let response = match res {
            Ok(r) => r,
            Err(ureq::Error::Status(_, r)) => r,
            Err(e) => return Err(format!("could not ask GitHub about releases: {e}")),
        };

        let Some(location) = response.header("location") else {
            /* A repository with no releases redirects to the releases page
               instead, which carries no tag. Not a failure — the honest state of
               a fork, same as `latest_release`'s empty tag. */
            return Ok(None);
        };

        Ok(tag_from_location(location).map(|tag| Peek {
            running: env!("CARGO_PKG_VERSION").to_string(),
            tag,
        }))
    })
    .await?
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(ASK_TIMEOUT)
        .timeout_read(ASK_TIMEOUT)
        /* Shared with the forges, and not optional: without it this trusts the
           one interception CA the machine's policy leaves valid for server auth,
           which happens to cover `api.github.com` and hid the problem for
           hours. `forge::tls_config` has the measurement. */
        .tls_config(crate::forge::tls_config())
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
        let into = fetch_to(&dir, &want, |got, total| {
            let _ = app.emit("update:progress", Progress { got, total });
        })?;
        Ok(into.to_string_lossy().to_string())
    })
    .await?
}

/// Download one asset into the holding directory and answer where it landed.
///
/// Shared by the button (`fetch_update`, which re-asked GitHub for `want`
/// first) and the tool (`self_update`, which resolved it off GitHub itself), so
/// there is one download and one set of checks on a thing that will be run.
/// `report` hears `(got, total)` every `REPORT_EVERY` and once at the end.
fn fetch_to(dir: &Path, want: &Asset, mut report: impl FnMut(u64, u64)) -> Result<PathBuf, String> {
    /* One name per version, so a second attempt overwrites rather than
       accumulating — and so a download interrupted half way is replaced by
       the next one instead of being run. */
    let into = dir.join(sane(&want.name));

    /* A lab's stand-in for GitHub (`feed_dir`) names its files by `feed:`, and
       "downloading" one is a copy. Only ever produced by `read_feed`, which only
       a debug build reaches, so a release build has no way to arrive here. */
    if let Some(file) = want.url.strip_prefix("feed:") {
        let Some(from) = feed_dir().map(|d| d.join(sane(file))) else {
            return Err("a lab feed file was named with no lab feed in place".into());
        };
        std::fs::copy(&from, &into)
            .map_err(|e| format!("could not copy {} from the lab feed: {e}", from.display()))?;
        let got = std::fs::metadata(&into).map(|m| m.len()).unwrap_or(0);
        report(got, got);
        return Ok(into);
    }

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
            report(got, total);
        }
    }
    report(got, total);
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
    Ok(into)
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
pub struct Arming(std::sync::Mutex<Option<Armed>>);

/// One installer waiting for the wall to go down, and what it is meant to do.
///
/// `from` and `to` ride along so the exit handler can leave a record the next
/// launch reads back (`landed`). `to` is known when the tool armed it and not
/// when the button did — the button arms a path, and a version read back out of
/// a file name would be a guess.
#[derive(Debug, Clone, PartialEq)]
pub struct Armed {
    pub path: PathBuf,
    pub from: String,
    pub to: Option<String>,
    /// Who asked, for the row the next launch writes: a card's name, or `None`
    /// for the button.
    pub asker: Option<String>,
}

impl Arming {
    /// What to run, taken rather than read — the exit handler runs twice in a
    /// clean quit (`ExitRequested` and then `Exit`), and launching an installer
    /// twice is two installers racing for one directory.
    pub fn take(&self) -> Option<Armed> {
        self.0.lock().ok().and_then(|mut a| a.take())
    }

    /// Whether a close is on its way to an install. Read by the main window's
    /// close, which must not clear the `Run` entry for a wall that is meant to
    /// come straight back (`lib.rs`).
    pub fn armed(&self) -> bool {
        self.0.lock().is_ok_and(|a| a.is_some())
    }

    fn set(&self, armed: Armed) -> Result<(), String> {
        let Ok(mut slot) = self.0.lock() else {
            return Err("could not arm the update".into());
        };
        *slot = Some(armed);
        Ok(())
    }
}

/// Is this a file `arm_update` may arm — one this app downloaded?
fn armable(dir: &Path, want: &Path) -> bool {
    want.is_file()
        && want.parent() == Some(dir)
        && want
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("exe"))
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
    if !armable(&dir, &want) {
        return Err(format!(
            "{path} is not an installer this app downloaded, so nothing was armed"
        ));
    }
    app.state::<Arming>().set(Armed {
        path: want,
        from: running(),
        to: None,
        asker: None,
    })
}

/// Launch whatever was armed. Called from the exit handler only.
///
/// Detached, and the one other place this app deliberately outlives itself is
/// `actions::launch_detached`, for the same reason said the other way round: the
/// whole point is a process that is still there when this one is not. Failure is
/// swallowed to a log line — the app is already on its way out, there is nothing
/// left to draw a message on, and the installer is still sitting in the data
/// directory to be run by hand.
///
/// **Two more things go with it, and both exist because the wall must come back.**
/// A machine left on the old version is a bad outcome; a machine with Volery *not
/// running* is a worse one, since the other laptop then has no peer and nothing
/// can reach it until somebody is in front of it (sink `549f6a63`). The
/// installer's `/R` restarts the wall when the install succeeds — and only then.
///
/// - **A record** (`UNDERWAY`) of what was attempted, so the next launch can say
///   whether it landed (`landed`). Written here rather than at arming, because
///   this is the moment an install was actually started: an arming a person then
///   stayed out of is not an attempt.
/// - **A watchdog** (`watch`), which waits for the installer *process* to exit and
///   starts the wall itself if nothing has by then. Started even when the
///   installer failed to launch, since that is the case where nothing else will.
pub fn run_armed(app: &AppHandle) {
    let Some(armed) = app.state::<Arming>().take() else {
        return;
    };
    let args = INSTALL_ARGS.iter().map(|s| s.to_string()).collect();
    let installer = match crate::actions::launch_detached(
        armed.path.to_string_lossy().to_string(),
        args,
        String::new(),
    ) {
        Ok(pid) => {
            eprintln!("[update] installer started as {pid}");
            Some(pid)
        }
        Err(e) => {
            eprintln!("[update] could not start the installer: {e}");
            None
        }
    };
    if let Ok(dir) = holding(app) {
        let record = Underway {
            from: armed.from.clone(),
            to: armed.to.clone(),
            asker: armed.asker.clone(),
            installer: armed.path.file_name().map(|n| n.to_string_lossy().to_string()),
            launched: installer.is_some(),
            at: now_ms(),
        };
        if let Ok(text) = serde_json::to_string(&record) {
            let _ = std::fs::write(dir.join(UNDERWAY), text);
        }
    }
    match std::env::current_exe() {
        Ok(exe) => watch(&exe, installer),
        Err(e) => eprintln!("[update] no path to start the wall again from: {e}"),
    }
}

/// Where the record of an install in flight is kept, in the holding directory.
const UNDERWAY: &str = "underway.json";

/// What the exit handler leaves for the next launch to read.
#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq)]
struct Underway {
    from: String,
    to: Option<String>,
    asker: Option<String>,
    installer: Option<String>,
    launched: bool,
    at: i64,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Start the wall again if the installer does not.
///
/// A hidden PowerShell rather than anything of ours, because everything of ours
/// is the exe being replaced: a copy of `skein.exe` waiting on the installer
/// would be holding the very file it is waiting to have written. The two by-hand
/// attempts this replaces both wrote this script, and both got the same two
/// things wrong, which is why it is code now:
///
/// - **It waits on the installer process, never its tree.** `Start-Process
///   -Wait` waits for every descendant, and `/R` makes the relaunched wall one of
///   them — so it never returns, and its last act (starting the wall) fires the
///   next time somebody *deliberately* closes Volery (sink `92d433d8`).
///   `WaitForExit` on the one process is the fix, capped at ten minutes so a
///   passive installer stuck on a dialog nobody will see does not leave the
///   machine wall-less for ever.
/// - **It matches the wall by its path, never by its name.** Lab walls and debug
///   builds are all `skein.exe` too; "is skein running" answers yes about
///   somebody else's test wall and leaves this machine with no wall at all.
///
/// The data rides in the environment rather than in the script text, so there is
/// no quoting of a path through two command-line parsers to get wrong.
fn watch(exe: &Path, installer: Option<u32>) {
    /* The wall that is exiting is waited out first, or the path check below
       would find *it* — still in its own exit handler — and conclude the wall
       was back. */
    const SCRIPT: &str = "$ErrorActionPreference = 'SilentlyContinue'; \
        $exe = $env:VOLERY_RELAUNCH_EXE; \
        $old = [int]$env:VOLERY_OLD_PID; \
        if ($old -gt 0) { $q = Get-Process -Id $old; if ($q) { [void]$q.WaitForExit(120000) } }; \
        $id = [int]$env:VOLERY_INSTALLER_PID; \
        if ($id -gt 0) { $p = Get-Process -Id $id; if ($p) { [void]$p.WaitForExit(600000) } }; \
        $until = (Get-Date).AddSeconds(45); \
        do { \
          if (Get-Process | Where-Object { $_.Path -eq $exe }) { exit 0 }; \
          Start-Sleep -Seconds 3 \
        } while ((Get-Date) -lt $until); \
        Remove-Item Env:VOLERY_RELAUNCH_EXE, Env:VOLERY_INSTALLER_PID, Env:VOLERY_OLD_PID; \
        Start-Process -FilePath $exe";
    let shell = std::env::var_os("SystemRoot")
        .map(|r| PathBuf::from(r).join(r"System32\WindowsPowerShell\v1.0\powershell.exe"))
        .filter(|p| p.is_file())
        .unwrap_or_else(|| PathBuf::from("powershell.exe"));
    let mut cmd = std::process::Command::new(shell);
    cmd.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", SCRIPT])
        .env("VOLERY_RELAUNCH_EXE", exe)
        .env("VOLERY_INSTALLER_PID", installer.unwrap_or(0).to_string())
        .env("VOLERY_OLD_PID", std::process::id().to_string())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    /* Outside every job of ours for `launch_detached`'s reason: it is the one
       thing that has to be running after this process is not. */
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    match cmd.spawn() {
        Ok(c) => eprintln!("[update] watchdog started as {}", c.id()),
        Err(e) => eprintln!("[update] could not start the watchdog: {e}"),
    }
}

/// Say, once, at launch, whether the install the last run started landed.
///
/// The card that asked for it went down with the wall and cannot report, and
/// a wall that came back on the old version looks exactly like one that was never
/// updated — so the record the exit handler left is read here and turned into a
/// chronicle row, then deleted. `good` if this build is not the one the install
/// started from, `bad` if it is.
pub fn landed(app: &AppHandle) {
    let Ok(dir) = holding(app) else { return };
    let at = dir.join(UNDERWAY);
    let Ok(text) = std::fs::read_to_string(&at) else { return };
    let _ = std::fs::remove_file(&at);
    let Ok(record) = serde_json::from_str::<Underway>(&text) else { return };
    let (level, mark, detail) = landing(&record, &running(), &dir.to_string_lossy());
    crate::chronicle::note(app, None, "volery", level, &mark, &detail);
}

/// The row `landed` writes — pure, so what a morning-after reads is tested.
fn landing(u: &Underway, now: &str, holding: &str) -> (&'static str, String, String) {
    let by = u.asker.as_deref().map(|a| format!(", asked for by {a}")).unwrap_or_default();
    if now != u.from {
        let expected = match u.to.as_deref() {
            Some(to) if to != now => format!(" — it was meant to be {to}"),
            _ => String::new(),
        };
        return (
            "good",
            format!("volery updated {} → {now}", u.from),
            format!("the wall came back on the new version by itself{by}{expected}"),
        );
    }
    let to = u.to.as_deref().map(|t| format!(" to {t}")).unwrap_or_default();
    let why = if u.launched {
        "the installer ran and the wall came back on the old version"
    } else {
        "the installer could not be started"
    };
    let file = u.installer.as_deref().unwrap_or("the installer");
    (
        "bad",
        format!("the update{to} did not land — still {now}"),
        format!("{why}{by}. {file} is still in {holding} to run by hand"),
    )
}

/* ── A card updating its own wall ────────────────────────────────────────── */

/// The tool a card calls to put the wall it stands on onto the newest release.
///
/// `update_volery` and not `update`: `update` is already an *action* — `task`'s
/// and `pull_request`'s — and their answers say it in backticks, which would read
/// as this tool to a card and to the guard that no result names a bare tool
/// (`supervisor::tests::no_tool_result_names_a_tool_a_card_cannot_call`).
pub const UPDATE_TOOL: &str = "update_volery";

/// The release workflow, by the file name the Actions API takes as its id. A tag
/// push is the only `push` that runs it (`release.yml`'s `on:`), so its `push`
/// runs are exactly the tags being built — which is how a tag that exists before
/// its installer does is told apart from a release. A test reads the workflow to
/// keep this name true.
const RELEASE_WORKFLOW: &str = "release.yml";

/// The smallest and largest installer worth running. A real one is ~18 MB; the
/// floor is what an HTML error page or a stub saved under the right name is
/// not, and the ceiling is what no installer of this app will ever be.
const SMALLEST_INSTALLER: u64 = 1024 * 1024;
const LARGEST_INSTALLER: u64 = 512 * 1024 * 1024;

/// The least time between the answer and the close: long enough for the tool's
/// reply to be written and read before anything goes down.
const CLOSE_AFTER: std::time::Duration = std::time::Duration::from_secs(1);

/// The most the close waits for the asking card's turn to end.
///
/// It waits at all because the first lab run closed a fixed three seconds after
/// the yes, and the card had *already* finished its sentence — so whether the
/// asker came back interrupted (and was sent a resume prompt about a turn that
/// had ended cleanly) was a race between its last sentence and a timer. Waiting
/// for the turn makes the clean end the ordinary one. Bounded, because a card
/// that keeps working after being told the wall is going must not hold an
/// approved update open for ever.
const TURN_GRACE: std::time::Duration = std::time::Duration::from_secs(60);

/// The two answers to the question, and the exact words a click sends.
const UPDATE_IT: &str = "update and restart";
const NOT_NOW: &str = "not now";

/// A version as three numbers, or `None` for one nothing should be ordered by.
///
/// **`update.ts::parseVersion` in Rust, held to the same table**
/// (`test/fixtures/versions.json`, read by both suites), because the tool is
/// answered here and the button there and two readings of "is this newer" that
/// disagree are a wall that offers one thing and installs another. `v0.6.1` and
/// `0.6.1` are one version; `0.7.0-rc.1` is not a version at all, which is the
/// whole prerelease policy; a part past `Number.MAX_SAFE_INTEGER` is refused
/// because the TypeScript side cannot hold it.
pub(crate) fn parse_version(s: &str) -> Option<(u64, u64, u64)> {
    const SAFE: u64 = (1 << 53) - 1;
    let s = s.trim();
    let s = s.strip_prefix('v').unwrap_or(s);
    let mut parts = s.split('.');
    let mut next = || -> Option<u64> {
        let p = parts.next()?;
        if p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        p.parse::<u64>().ok().filter(|n| *n <= SAFE)
    };
    let v = (next()?, next()?, next()?);
    parts.next().is_none().then_some(v)
}

fn said_version(v: (u64, u64, u64)) -> String {
    format!("{}.{}.{}", v.0, v.1, v.2)
}

/// One run of the release workflow, as much of it as the decision reads.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RunSeen {
    /// The tag it is building (`head_branch` on a tag push).
    pub tag: String,
    /// `queued`, `in_progress`, `completed`, … — GitHub's words, verbatim.
    pub status: String,
    /// `success`, `failure`, `cancelled`, … once completed.
    pub conclusion: Option<String>,
}

/// The newest published release: its tag and the assets fully uploaded to it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Release {
    pub tag: String,
    pub assets: Vec<Asset>,
}

/// Everything the decision is made from, gathered before it is made.
#[derive(Debug, Clone)]
pub(crate) struct Sighting {
    /// What this wall is.
    pub running: String,
    /// `None` for a repository with no release at all.
    pub release: Option<Release>,
    /// Newest first, as the Actions API lists them. `None` when the build queue
    /// could not be read — which is not fatal: a published release with its
    /// installer is safe to install whatever is building behind it.
    pub runs: Option<Vec<RunSeen>>,
}

/// What the tool makes of a sighting. Every arm but `Update` is a refusal with
/// a sentence of its own (`refusal`), and arms nothing.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Verdict {
    /// This build's own version cannot be read.
    Unversioned { running: String },
    /// The repository has no published release.
    NoRelease,
    /// The newest release's tag is not a version this can order.
    UnreadableTag { tag: String },
    /// What runs here is the newest release.
    Current { running: String },
    /// What runs here is newer than any release — built from source.
    Ahead { running: String, newest: String },
    /// A newer tag is building. `ready` is a newer release already installable,
    /// if there is one — named, and still not taken, because a second restart
    /// twenty minutes later is the cost of taking it.
    Building { tag: String, ready: Option<String> },
    /// A newer tag built green and its release is not readable yet.
    Publishing { tag: String },
    /// A newer tag's build failed, and nothing installable is newer than this.
    Failed { tag: String, conclusion: String, running: String },
    /// The newest release is newer and carries nothing this can drive.
    NoInstaller { version: String },
    /// Install `asset` to go from `from` to `to`. `failed` names a newer tag
    /// whose build failed, which is why this is not that one.
    Update { from: String, to: String, asset: Asset, failed: Option<String> },
}

/// The asset this can drive, or `None`: the NSIS `-setup.exe` of a plausible
/// size. `update.ts::pickInstaller` with the size check the button never
/// needed — a person pressing it has a progress bar to watch, and the tool's
/// whole point is that nobody is watching.
fn pick_installer(assets: &[Asset]) -> Option<&Asset> {
    assets.iter().find(|a| {
        a.name.to_ascii_lowercase().ends_with("-setup.exe")
            && (SMALLEST_INSTALLER..=LARGEST_INSTALLER).contains(&a.size)
    })
}

/// The whole decision, pure. **When in doubt, install nothing** — `update.ts`'s
/// rule, and sharper here: an update offered wrongly by the button is a person
/// declining it, and one taken wrongly by a card closes a wall nobody is at.
///
/// The order is the argument. A build in flight is looked at *before* the
/// release, because a tag exists before its installer does: answering "0.54.1 is
/// installable" while 0.55.0 is twelve minutes from done is two restarts where
/// one was coming. A *failed* build is looked at after — the release beside it
/// is still good, and a red build is no reason to keep a wall on an older green
/// one.
pub(crate) fn resolve(s: &Sighting) -> Verdict {
    let Some(running) = parse_version(&s.running) else {
        return Verdict::Unversioned { running: s.running.clone() };
    };
    let released = s
        .release
        .as_ref()
        .and_then(|r| parse_version(&r.tag).map(|v| (v, r)));
    let floor = released.map_or(running, |(v, _)| v.max(running));

    /* The newest tag the build queue knows about that is ahead of both what
       runs and what is released. Reversed so that of several runs for one tag
       (a re-run), the *newest* — first in GitHub's order — wins the tie. */
    let pending = s
        .runs
        .iter()
        .flatten()
        .rev()
        .filter_map(|r| parse_version(&r.tag).map(|v| (v, r)))
        .filter(|(v, _)| *v > floor)
        .max_by_key(|(v, _)| *v);

    let mut failed: Option<(String, String)> = None;
    if let Some((_, run)) = pending {
        let ready = released
            .filter(|(v, _)| *v > running)
            .map(|(v, _)| said_version(v));
        if run.status != "completed" {
            return Verdict::Building { tag: run.tag.clone(), ready };
        }
        match run.conclusion.as_deref() {
            Some("success") => return Verdict::Publishing { tag: run.tag.clone() },
            other => {
                failed = Some((run.tag.clone(), other.unwrap_or("without a result").to_string()))
            }
        }
    }

    let not_newer = |otherwise: Verdict| match &failed {
        Some((tag, conclusion)) => Verdict::Failed {
            tag: tag.clone(),
            conclusion: conclusion.clone(),
            running: said_version(running),
        },
        None => otherwise,
    };
    let Some(release) = &s.release else {
        return not_newer(Verdict::NoRelease);
    };
    let Some(newest) = parse_version(&release.tag) else {
        return Verdict::UnreadableTag { tag: release.tag.clone() };
    };
    if newest == running {
        return not_newer(Verdict::Current { running: said_version(running) });
    }
    if newest < running {
        return not_newer(Verdict::Ahead {
            running: said_version(running),
            newest: said_version(newest),
        });
    }
    match pick_installer(&release.assets) {
        None => Verdict::NoInstaller { version: said_version(newest) },
        Some(asset) => Verdict::Update {
            from: said_version(running),
            to: said_version(newest),
            asset: asset.clone(),
            failed: failed.map(|(tag, _)| tag),
        },
    }
}

/// What a refusal says. Each its own sentence, each ending on what was not done,
/// because the agent reading it has to pass it on and the person hearing it
/// wants to know first that nothing happened to their wall.
fn refusal(v: &Verdict) -> String {
    const NOTHING: &str = "Nothing was downloaded and nothing is armed.";
    match v {
        Verdict::Unversioned { running } => format!(
            "this build calls itself {running:?}, which is not a version anything can be compared \
             with, so it cannot tell whether a release is newer. {NOTHING}"
        ),
        Verdict::NoRelease => format!(
            "GitHub lists no published release of Volery, so there is nothing to install. {NOTHING}"
        ),
        Verdict::UnreadableTag { tag } => format!(
            "the newest release is tagged {tag:?}, which is not a version this can order — a \
             prerelease, or a mistake — so it is not installed. {NOTHING}"
        ),
        Verdict::Current { running } => format!(
            "Volery {running} is what runs here, and it is the newest release — there is nothing \
             to update to."
        ),
        Verdict::Ahead { running, newest } => format!(
            "this wall runs {running}, which is newer than the newest release ({newest}) — it was \
             built from source, and installing the release would take it backwards. {NOTHING}"
        ),
        Verdict::Building { tag, ready } => {
            let also = ready
                .as_deref()
                .map(|r| {
                    format!(
                        " {r} is published and installable now, and is not taken: it would be a \
                         second restart when {tag} lands."
                    )
                })
                .unwrap_or_default();
            format!(
                "{tag} is still building — a tag exists before its installer does, and a release \
                 build takes about twenty minutes. {NOTHING}{also} Call this again once the build \
                 is done; `mcp__skein__wake_me` is the way to wait for it."
            )
        }
        Verdict::Publishing { tag } => format!(
            "{tag} built green, and its release is not showing on GitHub yet — publishing is the \
             build's last step. Ask again in a minute. {NOTHING}"
        ),
        Verdict::Failed { tag, conclusion, running } => format!(
            "the build for {tag} ended `{conclusion}`, so it has no installer behind it, and no \
             published release is newer than what runs here ({running}). {NOTHING} A failed \
             release is somebody's to fix and tag again; installing nothing is the right answer \
             until then."
        ),
        Verdict::NoInstaller { version } => format!(
            "release {version} carries no NSIS installer (`…-setup.exe`) that is fully uploaded \
             and of a plausible size — the one file this can drive. {NOTHING}"
        ),
        Verdict::Update { .. } => String::new(),
    }
}

/// The line every answer ends on: whether this wall takes work from other walls.
///
/// A wall updated *so that* it can be driven from elsewhere, and then quietly
/// refusing every remote spawn, is a trap with good manners. The switch is a
/// person's (`flyway::here`), so this reports it and never sets it.
fn accepting_line(accepting: bool) -> &'static str {
    if accepting {
        "This wall takes work from other walls, so a card elsewhere can still open one here once \
         it is back."
    } else {
        "This wall does **not** take work from other walls: once it is back, a card on another \
         machine cannot open one here. That switch is a person's, at this machine, and nothing \
         here turns it on — say so to whoever asked if they meant to drive this wall from \
         elsewhere."
    }
}

/// Where a lab keeps its stand-in for GitHub. Debug builds only.
///
/// A lab wall is a debug build, and a debug build refuses this tool (installing
/// the release would replace the *installed* wall — and close it, since the
/// installer closes every `skein.exe` it finds). So the one way to watch the
/// whole path run on a lab is to hand it a feed: a directory holding `feed.json`
/// — what GitHub would have said — and the files it names, which "download" by
/// copying. Everything after the lookup is the real code. A release build never
/// reads the variable.
const FEED_VAR: &str = "VOLERY_UPDATE_FEED";

fn feed_dir() -> Option<PathBuf> {
    if !cfg!(debug_assertions) {
        return None;
    }
    std::env::var_os(FEED_VAR)
        .map(PathBuf::from)
        .filter(|d| d.join("feed.json").is_file())
}

#[derive(serde::Deserialize, Default)]
struct Feed {
    /// The version this wall pretends to be. A stand-in installer rewrites it,
    /// which is how a lab "comes back on the new version".
    running: Option<String>,
    release: Option<FeedRelease>,
    #[serde(default)]
    runs: Vec<FeedRun>,
}

#[derive(serde::Deserialize)]
struct FeedRelease {
    tag: String,
    #[serde(default)]
    assets: Vec<FeedAsset>,
}

#[derive(serde::Deserialize)]
struct FeedAsset {
    name: String,
    file: String,
}

#[derive(serde::Deserialize)]
struct FeedRun {
    tag: String,
    status: String,
    conclusion: Option<String>,
}

fn feed() -> Option<Feed> {
    let text = std::fs::read_to_string(feed_dir()?.join("feed.json")).ok()?;
    serde_json::from_str(&text).ok()
}

/// The version this wall is, for every comparison the tool makes — this build's
/// own, or the lab feed's.
fn running() -> String {
    feed()
        .and_then(|f| f.running)
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string())
}

fn read_feed(dir: &Path) -> Result<Sighting, String> {
    let text = std::fs::read_to_string(dir.join("feed.json"))
        .map_err(|e| format!("could not read the lab feed: {e}"))?;
    let feed: Feed =
        serde_json::from_str(&text).map_err(|e| format!("the lab feed is not readable: {e}"))?;
    let release = feed.release.map(|r| Release {
        tag: r.tag,
        assets: r
            .assets
            .into_iter()
            .map(|a| Asset {
                size: std::fs::metadata(dir.join(sane(&a.file))).map(|m| m.len()).unwrap_or(0),
                url: format!("feed:{}", a.file),
                name: a.name,
            })
            .collect(),
    });
    let runs = feed
        .runs
        .into_iter()
        .map(|r| RunSeen { tag: r.tag, status: r.status, conclusion: r.conclusion })
        .collect();
    Ok(Sighting {
        running: feed.running.unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string()),
        release,
        runs: Some(runs),
    })
}

/// The newest release out of `/releases/latest`, keeping only the assets that
/// are an `https` download and fully uploaded (`state` is `uploaded` — an asset
/// mid-upload is `open`, and is a truncated installer with a URL).
fn release_of(body: &Value) -> Option<Release> {
    let tag = body["tag_name"].as_str()?.trim();
    if tag.is_empty() {
        return None;
    }
    let assets = body["assets"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|it| {
                    let url = it["browser_download_url"].as_str()?;
                    let uploaded = it
                        .get("state")
                        .and_then(Value::as_str)
                        .is_none_or(|s| s == "uploaded");
                    (url.starts_with("https://") && uploaded).then(|| Asset {
                        name: it["name"].as_str().unwrap_or_default().to_string(),
                        url: url.to_string(),
                        size: it["size"].as_u64().unwrap_or(0),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Some(Release { tag: tag.to_string(), assets })
}

/// The release workflow's runs, newest first.
fn runs_of(body: &Value) -> Vec<RunSeen> {
    body["workflow_runs"]
        .as_array()
        .map(|rs| {
            rs.iter()
                .filter_map(|r| {
                    Some(RunSeen {
                        tag: r["head_branch"].as_str()?.to_string(),
                        status: r["status"].as_str()?.to_string(),
                        conclusion: r["conclusion"].as_str().map(str::to_string),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Ask GitHub — or the lab's feed — everything `resolve` needs. Blocking; called
/// on the MCP request's own thread, which parks nobody else.
///
/// Two API requests of the sixty an hour, spent only when a card asks. The
/// release is required; the build queue is not, since its only use is to hold
/// back an update that would be overtaken, and a published release with its
/// installer is safe to install whatever is building behind it.
fn sight() -> Result<Sighting, String> {
    if let Some(dir) = feed_dir() {
        return read_feed(&dir);
    }
    let Some(repo) = repo() else {
        return Err("this build does not name a repository to update from".into());
    };
    let ask = |url: &str| {
        agent()
            .get(url)
            .set("User-Agent", concat!("volery/", env!("CARGO_PKG_VERSION")))
            .set("Accept", "application/vnd.github+json")
            .call()
    };
    let release = match ask(&format!("https://api.github.com/repos/{repo}/releases/latest")) {
        Ok(res) => {
            let body: Value = res
                .into_json()
                .map_err(|e| format!("GitHub's answer was not readable: {e}"))?;
            release_of(&body)
        }
        /* No release at all is a 404 here, and is an answer rather than a fault. */
        Err(ureq::Error::Status(404, _)) => None,
        Err(e) => return Err(format!("could not ask GitHub about releases: {e}")),
    };
    let runs = ask(&format!(
        "https://api.github.com/repos/{repo}/actions/workflows/{RELEASE_WORKFLOW}/runs?event=push&per_page=10"
    ))
    .ok()
    .and_then(|r| r.into_json::<Value>().ok())
    .map(|b| runs_of(&b));
    Ok(Sighting { running: running(), release, runs })
}

/// Is the file at `path` the installer `want` describes? Its length is the one
/// the release states, the length is plausible, and it starts as a Windows
/// executable does. Answers the length.
fn verify(path: &Path, want: &Asset) -> Result<u64, String> {
    let len = std::fs::metadata(path)
        .map(|m| m.len())
        .map_err(|e| format!("the installer is not there: {e}"))?;
    if want.size > 0 && len != want.size {
        return Err(format!(
            "the download is {len} bytes where the release says {} — it is not the file GitHub \
             is offering",
            want.size
        ));
    }
    if !(SMALLEST_INSTALLER..=LARGEST_INSTALLER).contains(&len) {
        return Err(format!("the download is {len} bytes, which no installer of this app is"));
    }
    let mut head = [0u8; 2];
    std::fs::File::open(path)
        .and_then(|mut f| f.read_exact(&mut head))
        .map_err(|e| format!("could not read the installer back: {e}"))?;
    if &head != b"MZ" {
        return Err("the download is not a Windows executable".into());
    }
    Ok(len)
}

/// Other copies of `skein.exe` on this machine, running from anywhere but here.
///
/// The installer closes every `skein.exe` the user has (`CheckIfAppIsRunning`,
/// matched by name in passive mode) — a lab wall and a development build
/// included — so the person approving is told how many will go down with this
/// one. Zero with a lab feed in place, whose stand-in closes nothing.
fn other_copies() -> usize {
    if feed_dir().is_some() {
        return 0;
    }
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let me = std::env::current_exe().ok();
    let own = sysinfo::get_current_pid().ok();
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_exe(UpdateKind::OnlyIfNotSet),
    );
    sys.processes()
        .values()
        .filter(|p| Some(p.pid()) != own)
        .filter(|p| p.name().to_string_lossy().eq_ignore_ascii_case("skein.exe"))
        .filter(|p| p.exe().map(Path::to_path_buf) != me)
        .count()
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// What an `update` call turns out to be. `smith::Writing`'s shape, for its reason.
pub(crate) enum Updating {
    /// Answer with this, now — every refusal, and anything that went wrong
    /// before there was something worth a person's attention.
    Now(String),
    /// Put this question up and wait; `settle` arms and closes on a yes.
    Ask {
        question: Value,
        settle: crate::ask::Settle,
    },
}

/// The `update` tool, as far as it can be decided without a person.
///
/// Called from `ask.rs` ahead of the roster chain, the way `smith::pull_request`
/// is: it may park, and the chain has already committed to answering on the spot.
///
/// **The confirmation is the tool's own and it travels** (`Settle::new`). The
/// update is driven, in the case it exists for, by a card Lyss opened on the far
/// laptop while she sits at the near one; a question that only appeared on the
/// machine being updated would strand there with nobody to answer it. The quit
/// dialog cannot be that question — it is `quit.rs`'s own `CloseRequested` path
/// and never crosses — so this one says everything that dialog would have (how
/// many cards have background work the restart takes down), and a yes to it
/// consents for the close too (`Quit::consent`), so the far machine never puts up
/// a second question nobody is there to see.
///
/// **Downloaded and checked before anyone is asked.** Nothing reaches a person
/// until it is worth their attention, and "18.2 MB, downloaded and checked" is a
/// fact they decide on; a download that failed after a yes would be a yes spent
/// on nothing.
pub(crate) fn self_update(app: &AppHandle, caller: &str, args: &Value) -> Updating {
    let (who, accepting) = {
        let Some(store) = app.try_state::<crate::store::Store>() else {
            return Updating::Now("the store is unavailable".into());
        };
        let Ok(conn) = store.0.lock() else {
            return Updating::Now("the store is unavailable".into());
        };
        let Some(me) = crate::store::roster_one(&conn, caller) else {
            return Updating::Now("this conversation is not on the wall.".into());
        };
        if me.kind == "chat" {
            return Updating::Now(
                "this is a chat card: it reaches nothing on this machine, and closing the wall to \
                 install software is the most of the machine there is. Nothing was done."
                    .into(),
            );
        }
        let short: String = me.id.chars().take(8).collect();
        let title = if me.title.trim().is_empty() { "an untitled card" } else { me.title.trim() };
        let from = crate::flyway::here::birth_of(&conn, caller)
            .map(|b| format!(", opened from {}", b.host))
            .unwrap_or_default();
        (format!("{title} ({short}){from}"), crate::flyway::here::accepting(&conn))
    };
    let tail = accepting_line(accepting);

    if cfg!(debug_assertions) && feed_dir().is_none() {
        return Updating::Now(format!(
            "this is a development build of Volery, not the installed one, so it does not update \
             itself: the release's installer replaces the *installed* wall — and closes it, since \
             it closes every `skein.exe` it finds — rather than this one. Nothing was done. A lab \
             wall can be pointed at a stand-in release with `{FEED_VAR}` (see \
             `.claude/rules/update.md`). {tail}"
        ));
    }

    let seen = match sight() {
        Ok(s) => s,
        Err(e) => {
            return Updating::Now(format!(
                "{e}. Nothing was downloaded and nothing is armed. {tail}"
            ))
        }
    };
    let (from, to, asset, failed) = match resolve(&seen) {
        Verdict::Update { from, to, asset, failed } => (from, to, asset, failed),
        other => return Updating::Now(format!("{} {tail}", refusal(&other))),
    };

    let dir = match holding(app) {
        Ok(d) => d,
        Err(e) => return Updating::Now(format!("{e}. Nothing is armed. {tail}")),
    };
    let path = match fetch_to(&dir, &asset, |_, _| {}) {
        Ok(p) => p,
        Err(e) => return Updating::Now(format!("{e}. Nothing is armed. {tail}")),
    };
    let len = match verify(&path, &asset) {
        Ok(len) => len,
        Err(e) => {
            let _ = std::fs::remove_file(&path);
            return Updating::Now(format!(
                "{e}, so it was deleted and nothing is armed. {tail}"
            ));
        }
    };

    let asking = Asking {
        machine: crate::flyway::key::host_name(),
        from: from.clone(),
        to: to.clone(),
        installer: asset.name.clone(),
        size: format!("{:.1} MB", len as f64 / 1_048_576.0),
        who: who.clone(),
        busy: app.try_state::<crate::quit::Quit>().map_or(0, |q| q.busy()),
        others_mid: app
            .try_state::<crate::supervisor::Supervisor>()
            .map_or(0, |s| s.mid_turn().iter().filter(|id| id.as_str() != caller).count()),
        copies: other_copies(),
        accepting,
        why: args
            .get("why")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|w| !w.is_empty())
            .map(str::to_string),
        overtaken: failed,
    };
    let (question, confirm) = (question_of(&asking), evidence_of(&asking));
    let caller = caller.to_string();

    Updating::Ask {
        question,
        settle: crate::ask::Settle::new(confirm, move |app, answer| {
            let Some(answer) = answer else {
                return format!(
                    "nobody answered, so nothing was armed — the wall stays on {from}. Say that you \
                     offered; do not simply try again. {tail}"
                );
            };
            let said = answer.trim();
            if !said.eq_ignore_ascii_case(UPDATE_IT) {
                if said.eq_ignore_ascii_case(NOT_NOW) {
                    return format!(
                        "the person was asked and said not now, so nothing was armed and the wall \
                         stays on {from}. That is an answer rather than this tool refusing you — \
                         do not ask again about {to}; say that you offered. {tail}"
                    );
                }
                return format!(
                    "the person was asked and pressed neither button. They said: {said:?}. \
                     Nothing was armed. Act on what they actually said. {tail}"
                );
            }
            /* Re-checked, because up to three-quarters of an hour can pass
               between the download and the yes, and what is about to be run is
               whatever is at that path now. */
            let Ok(dir) = holding(app) else {
                return format!("the data directory is not there any more, so nothing was armed. {tail}");
            };
            if !armable(&dir, &path) || verify(&path, &asset).is_err() {
                return format!(
                    "the downloaded installer is gone or no longer checks out, so nothing was \
                     armed. Call `mcp__skein__update_volery` again to fetch it afresh. {tail}"
                );
            }
            if let Err(e) = app.state::<Arming>().set(Armed {
                path: path.clone(),
                from: from.clone(),
                to: Some(to.clone()),
                asker: Some(who.clone()),
            }) {
                return format!("{e}, so nothing will be installed. {tail}");
            }
            /* The receipt, before the close — the card is about to be cut off
               and cannot report afterwards, so this row is the record on the
               wall the morning after. `landed` writes the other half. */
            crate::chronicle::note(
                app,
                None,
                "volery",
                "note",
                &format!("updating volery {from} → {to}"),
                &format!(
                    "asked for by {who}, and approved — the wall closes now and the installer \
                     brings it back"
                ),
            );
            /* The person already said yes to a question that told them what the
               quit dialog would have; a second one on this machine is the thing
               that strands a remote update. */
            if let Some(q) = app.try_state::<crate::quit::Quit>() {
                q.consent();
            }
            close_soon(app, caller.clone());
            format!(
                "armed: Volery {to} will be installed over {from}. The wall closes as soon as \
                 this turn of yours ends — so end it now, saying that it is restarting — and the \
                 installer brings it back on {to} by itself. A turn still running a minute from \
                 now is cut off and resumed afterwards. Nothing reports back on its own: a \
                 chronicle row saying this was written before the close, the next launch writes \
                 another saying whether it landed, and if you are asked afterwards, calling \
                 `mcp__skein__update_volery` again says {to} is current. {tail}"
            )
        }),
    }
}

/// Everything the question is written from, gathered before it is written —
/// so the two copies of it (the one drawn here and the one that travels) are
/// pure, and a test can hold both.
struct Asking {
    machine: String,
    from: String,
    to: String,
    installer: String,
    size: String,
    who: String,
    /// Cards holding background work — `quit.rs`'s own count, so this says
    /// exactly what the quit dialog would have.
    busy: usize,
    /// Other cards mid-turn, which come back interrupted and pick up again.
    others_mid: usize,
    /// Other `skein.exe` the installer will close (`other_copies`).
    copies: usize,
    accepting: bool,
    why: Option<String>,
    /// A newer tag whose build failed, which is why this is not that one.
    overtaken: Option<String>,
}

impl Asking {
    fn busy_said(&self) -> String {
        if self.busy == 0 {
            "none".to_string()
        } else {
            format!(
                "{} — taken down by the restart, and not resumed",
                plural(self.busy, "card", "cards")
            )
        }
    }

    fn mid_said(&self) -> String {
        if self.others_mid == 0 {
            "none besides the card asking".to_string()
        } else {
            format!(
                "{} — they come back marked interrupted and pick up again",
                plural(self.others_mid, "other card", "other cards")
            )
        }
    }

    fn copies_said(&self) -> Option<String> {
        (self.copies > 0).then(|| {
            format!(
                "{} running from elsewhere — a lab wall or a development build — and the \
                 installer closes those too",
                plural(self.copies, "other copy of skein.exe", "other copies of skein.exe")
            )
        })
    }
}

/// The question as it is drawn on this wall.
fn question_of(a: &Asking) -> Value {
    let overtaken = a
        .overtaken
        .as_deref()
        .map(|t| format!(" ({t} is newer, and its build failed — this is the newest that has an installer.)"))
        .unwrap_or_default();
    let mut lines = vec![format!(
        "A card wants to update Volery on **{}** from **{}** to **{}**, and restart it.{overtaken}",
        a.machine, a.from, a.to
    )];
    if let Some(w) = &a.why {
        lines.push(format!("> {w}"));
    }
    lines.push(format!(
        "The installer ({}, {}) is downloaded and checked. On yes the wall closes as soon as the \
         asking card has said so, the installer runs, and the wall comes back on {} by itself.",
        a.installer, a.size, a.to
    ));
    let mut facts = vec![
        format!("- asked by: {}", a.who),
        format!("- background work: {}", a.busy_said()),
        format!("- mid-turn: {}", a.mid_said()),
    ];
    if let Some(c) = a.copies_said() {
        facts.push(format!("- also running: {c}"));
    }
    facts.push(format!(
        "- takes work from other walls: {}",
        if a.accepting { "yes" } else { "no — and this does not change that" }
    ));
    lines.push(facts.join("\n"));
    json!({
        "questions": [{
            "header": "update volery",
            "question": lines.join("\n\n"),
            "options": [
                {
                    "label": UPDATE_IT,
                    "detail": format!("Arm the installer and close the wall now; it comes back on {}.", a.to)
                },
                { "label": NOT_NOW, "detail": "Nothing is armed. The card is told you said so." }
            ]
        }]
    })
}

/// The same question in fields, as a person at another wall decides it
/// (`ask::Confirm`). Every fact is written to mean the same on either machine:
/// versions, a file, counts — never *here*. The machine is stamped at park.
fn evidence_of(a: &Asking) -> crate::ask::Confirm {
    let mut c = crate::ask::Confirm::new("update volery and restart it")
        .fact("from", a.from.clone())
        .fact("to", format!("{} — {}, {}, downloaded and checked", a.to, a.installer, a.size))
        .fact("asked by", a.who.clone())
        .fact("background work", a.busy_said())
        .fact("mid-turn", a.mid_said());
    if let Some(copies) = a.copies_said() {
        c = c.fact("also running", copies);
    }
    if let Some(t) = &a.overtaken {
        c = c.fact("not taken", format!("{t} — its build failed"));
    }
    c.fact(
        "takes work from other walls",
        if a.accepting { "yes" } else { "no, and this does not change that" },
    )
    .why(a.why.as_deref())
    .stakes(
        "The wall on that machine closes within a minute and every card on it stops; background \
         work is lost. It comes back on the new version by itself — and if it does not, nothing on that \
         machine can be reached until somebody starts it.",
    )
}

/// Close the wall once the asking card has finished its turn, through the main
/// window's own close — so the frame is saved, the quit latch is read (and was
/// consented), and the exit handler runs `run_armed`, exactly as the button's
/// close does.
///
/// The wait reads `Supervisor::mid_turn`, the reader thread's own turn mark —
/// in-process state, a quarter-second apart, for at most `TURN_GRACE`, once, on
/// the way out of an approved update. Not a poller in `CLAUDE.md`'s sense: it
/// ends with the process.
fn close_soon(app: &AppHandle, caller: String) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(CLOSE_AFTER);
        let until = std::time::Instant::now() + TURN_GRACE;
        while std::time::Instant::now() < until
            && app
                .try_state::<crate::supervisor::Supervisor>()
                .is_some_and(|s| s.mid_turn().contains(&caller))
        {
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
        match app.get_webview_window("main") {
            Some(w) => {
                if let Err(e) = w.close() {
                    eprintln!("[update] the window would not close ({e}); exiting instead");
                    app.exit(0);
                }
            }
            None => app.exit(0),
        }
    });
}

/// The tool as the roster advertises it. Deferred: a card knows from what it was
/// asked whether it is updating a wall, and nearly no turn is.
pub(crate) fn update_schema() -> Value {
    json!({
        "name": UPDATE_TOOL,
        "description": "Install the newest Volery release on the machine this card runs on, and have the wall come back on it by itself — the way to update a wall nobody is sitting at. It does what the in-app update button does: asks GitHub for the newest *published* release, downloads its installer and checks it, then puts a confirmation in front of the person, which reaches them on whichever wall they are at. Only on their yes does it arm the installer and close this wall; the installer runs as the wall goes down and starts it again on the new version.\n\nIt refuses, in a sentence of its own and arming nothing, when this wall is already current, when a newer tag's build is still running or failed, when the release has no installer, or when this is a development build. Each is an answer, not a fault: pass it on to whoever asked. Every answer also says whether this wall takes work from other walls, which is a person's switch this never changes.\n\n**The wall closes as soon as your turn ends**, so when the answer comes back, say that it is restarting and stop; a turn still running a minute later is cut off. Nothing reports back by itself: the wall writes a chronicle row before it goes and another when it is back, and if you are asked afterwards, calling this again says the new version is current. Do not script an update by hand (a detached script, `Start-Process`, WMI, a scheduled task): this replaces that, and every by-hand attempt so far hit a trap it owns.\n\nIt updates the wall it is served from and no other. To update another machine, open a card there (`spawn` with `host`) and ask that card to call this.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "why": {
                    "type": "string",
                    "description": "One sentence on why, shown to the person approving — who asked for it, or what it is for."
                }
            }
        }
    })
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

    fn armed(path: &str) -> Armed {
        Armed { path: PathBuf::from(path), from: "0.54.0".into(), to: None, asker: None }
    }

    /// Taken, not read: a clean quit runs the exit handler twice.
    #[test]
    fn arming_is_spent_the_first_time_it_is_asked() {
        let a = Arming::default();
        a.set(armed("x.exe")).unwrap();
        assert!(a.armed(), "the close reads this to keep the Run entry");
        assert_eq!(a.take(), Some(armed("x.exe")));
        assert_eq!(a.take(), None);
        assert!(!a.armed());
    }

    #[test]
    fn nothing_armed_is_the_ordinary_case_and_not_a_failure() {
        assert_eq!(Arming::default().take(), None);
        assert!(!Arming::default().armed());
    }

    /* ── the update tool ─────────────────────────────────────────────────── */

    #[derive(serde::Deserialize)]
    struct Table {
        parse: Vec<ParseCase>,
        newer: Vec<NewerCase>,
    }
    #[derive(serde::Deserialize)]
    struct ParseCase {
        s: String,
        is: Option<[u64; 3]>,
    }
    #[derive(serde::Deserialize)]
    struct NewerCase {
        tag: String,
        running: String,
        newer: bool,
    }

    /// `update.ts` reads the same file. Two readings of "is this newer" that
    /// disagree are a wall that offers one release and installs another.
    #[test]
    fn versions_read_the_way_update_ts_reads_them() {
        let t: Table =
            serde_json::from_str(include_str!("../../test/fixtures/versions.json")).unwrap();
        assert!(t.parse.len() > 10 && t.newer.len() > 5, "the table is the test");
        for c in &t.parse {
            assert_eq!(parse_version(&c.s), c.is.map(|v| (v[0], v[1], v[2])), "{:?}", c.s);
        }
        for c in &t.newer {
            let newer = match (parse_version(&c.tag), parse_version(&c.running)) {
                (Some(a), Some(b)) => a > b,
                _ => false,
            };
            assert_eq!(newer, c.newer, "{} over {}", c.tag, c.running);
        }
    }

    const MB: u64 = 1024 * 1024;

    fn setup(name: &str, size: u64) -> Asset {
        Asset {
            name: name.into(),
            url: format!("https://github.com/o/r/releases/download/x/{name}"),
            size,
        }
    }

    fn release(tag: &str) -> Release {
        Release {
            tag: tag.into(),
            assets: vec![
                setup(&format!("Volery_{}_x64-setup.exe", tag.trim_start_matches('v')), 18 * MB),
                setup(&format!("Volery_{}_x64_en-US.msi", tag.trim_start_matches('v')), 26 * MB),
            ],
        }
    }

    fn run(tag: &str, status: &str, conclusion: Option<&str>) -> RunSeen {
        RunSeen { tag: tag.into(), status: status.into(), conclusion: conclusion.map(str::to_string) }
    }

    fn sighting(running: &str, rel: Option<Release>, runs: Vec<RunSeen>) -> Sighting {
        Sighting { running: running.into(), release: rel, runs: Some(runs) }
    }

    /// The case it exists for: a newer release with its installer, nothing
    /// building past it.
    #[test]
    fn a_newer_release_with_an_installer_is_installed() {
        let s = sighting(
            "0.54.0",
            Some(release("v0.55.0")),
            vec![run("v0.55.0", "completed", Some("success")), run("v0.54.0", "completed", Some("success"))],
        );
        match resolve(&s) {
            Verdict::Update { from, to, asset, failed } => {
                assert_eq!((from.as_str(), to.as_str()), ("0.54.0", "0.55.0"));
                assert!(asset.name.ends_with("-setup.exe"), "the NSIS one, never the MSI");
                assert_eq!(failed, None);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn the_newest_release_already_running_is_current() {
        let s = sighting("0.54.0", Some(release("v0.54.0")), vec![run("v0.54.0", "completed", Some("success"))]);
        assert_eq!(resolve(&s), Verdict::Current { running: "0.54.0".into() });
    }

    /// A tag exists before its installer does. Installing the release behind it
    /// would be a second restart twenty minutes later, so nothing is taken —
    /// and the installable one is still named.
    #[test]
    fn a_build_in_flight_holds_everything_back() {
        let s = sighting(
            "0.54.0",
            Some(release("v0.54.1")),
            vec![run("v0.55.0", "in_progress", None), run("v0.54.1", "completed", Some("success"))],
        );
        assert_eq!(
            resolve(&s),
            Verdict::Building { tag: "v0.55.0".into(), ready: Some("0.54.1".into()) }
        );
        let s = sighting("0.54.0", Some(release("v0.54.0")), vec![run("v0.55.0", "queued", None)]);
        assert_eq!(resolve(&s), Verdict::Building { tag: "v0.55.0".into(), ready: None });
    }

    /// The shipped-twice mistake is fetching the newest *tag*: a red build has
    /// no installer behind it, and the wall stays where it is.
    #[test]
    fn a_failed_build_installs_nothing_when_nothing_older_is_newer() {
        let s = sighting(
            "0.54.0",
            Some(release("v0.54.0")),
            vec![run("v0.55.0", "completed", Some("failure")), run("v0.54.0", "completed", Some("success"))],
        );
        assert_eq!(
            resolve(&s),
            Verdict::Failed { tag: "v0.55.0".into(), conclusion: "failure".into(), running: "0.54.0".into() }
        );
    }

    /// …and a red build is no reason to keep a wall on an older green one.
    #[test]
    fn a_failed_build_does_not_hold_back_a_good_release_beside_it() {
        let s = sighting(
            "0.54.0",
            Some(release("v0.54.1")),
            vec![run("v0.55.0", "completed", Some("failure")), run("v0.54.1", "completed", Some("success"))],
        );
        match resolve(&s) {
            Verdict::Update { to, failed, .. } => {
                assert_eq!(to, "0.54.1");
                assert_eq!(failed.as_deref(), Some("v0.55.0"));
            }
            other => panic!("{other:?}"),
        }
    }

    /// A re-run: the newest run for a tag is the one that counts, and GitHub
    /// lists newest first.
    #[test]
    fn the_newest_run_of_a_tag_decides_it() {
        let s = sighting(
            "0.54.0",
            Some(release("v0.54.0")),
            vec![run("v0.55.0", "in_progress", None), run("v0.55.0", "completed", Some("failure"))],
        );
        assert!(matches!(resolve(&s), Verdict::Building { .. }), "{:?}", resolve(&s));
    }

    #[test]
    fn green_but_not_yet_published_says_to_ask_again() {
        let s = sighting("0.54.0", Some(release("v0.54.0")), vec![run("v0.55.0", "completed", Some("success"))]);
        assert_eq!(resolve(&s), Verdict::Publishing { tag: "v0.55.0".into() });
    }

    #[test]
    fn a_release_with_no_installer_is_refused() {
        let mut r = release("v0.55.0");
        r.assets.retain(|a| !a.name.ends_with("-setup.exe"));
        let s = sighting("0.54.0", Some(r), vec![]);
        assert_eq!(resolve(&s), Verdict::NoInstaller { version: "0.55.0".into() });
    }

    /// The tool's own check the button never needed: nobody is watching a
    /// progress bar, so a setup.exe that is a few bytes is refused here.
    #[test]
    fn an_installer_of_no_plausible_size_is_no_installer() {
        for size in [0, 900, 4096, LARGEST_INSTALLER + 1] {
            let r = Release { tag: "v0.55.0".into(), assets: vec![setup("Volery_0.55.0_x64-setup.exe", size)] };
            let s = sighting("0.54.0", Some(r), vec![]);
            assert_eq!(resolve(&s), Verdict::NoInstaller { version: "0.55.0".into() }, "{size}");
        }
    }

    #[test]
    fn the_odd_shapes_refuse() {
        assert_eq!(resolve(&sighting("0.54.0", None, vec![])), Verdict::NoRelease);
        assert_eq!(
            resolve(&sighting("0.54.0", Some(release("v0.55.0-rc.1")), vec![])),
            Verdict::UnreadableTag { tag: "v0.55.0-rc.1".into() }
        );
        assert_eq!(
            resolve(&sighting("0.56.0", Some(release("v0.55.0")), vec![])),
            Verdict::Ahead { running: "0.56.0".into(), newest: "0.55.0".into() }
        );
        assert_eq!(
            resolve(&sighting("dev", Some(release("v0.55.0")), vec![])),
            Verdict::Unversioned { running: "dev".into() }
        );
    }

    /// An unreadable build queue is not a refusal: a published release with its
    /// installer is safe whatever is building behind it.
    #[test]
    fn an_unreadable_build_queue_does_not_block_a_good_release() {
        let s = Sighting { running: "0.54.0".into(), release: Some(release("v0.55.0")), runs: None };
        assert!(matches!(resolve(&s), Verdict::Update { .. }));
    }

    /// Every refusal says nothing was done, and says it in words of its own.
    #[test]
    fn every_refusal_says_it_armed_nothing() {
        let all = [
            Verdict::Unversioned { running: "dev".into() },
            Verdict::NoRelease,
            Verdict::UnreadableTag { tag: "x".into() },
            Verdict::Ahead { running: "1.0.0".into(), newest: "0.9.0".into() },
            Verdict::Building { tag: "v1.0.0".into(), ready: Some("0.9.9".into()) },
            Verdict::Publishing { tag: "v1.0.0".into() },
            Verdict::Failed { tag: "v1.0.0".into(), conclusion: "failure".into(), running: "0.9.0".into() },
            Verdict::NoInstaller { version: "1.0.0".into() },
        ];
        let mut seen = std::collections::HashSet::new();
        for v in &all {
            let s = refusal(v);
            assert!(s.contains("Nothing was downloaded and nothing is armed") || s.contains("Nothing was done"), "{s}");
            assert!(seen.insert(s.clone()), "two refusals read the same: {s}");
        }
        assert!(refusal(&Verdict::Current { running: "0.54.0".into() }).contains("nothing to update to"));
    }

    /// The shape `/releases/latest` really answers, trimmed from the v0.54.0
    /// probe. An asset still uploading (`state: open`) is a truncated installer
    /// with a URL, and is not kept.
    #[test]
    fn a_release_is_read_off_githubs_answer() {
        let body = json!({
            "tag_name": "v0.54.0",
            "assets": [
                { "name": "Volery_0.54.0_x64-setup.exe", "size": 18197723, "state": "uploaded",
                  "browser_download_url": "https://github.com/ShaitanLyss/volery/releases/download/v0.54.0/Volery_0.54.0_x64-setup.exe" },
                { "name": "Volery_0.54.0_x64_en-US.msi", "size": 26218496, "state": "open",
                  "browser_download_url": "https://github.com/ShaitanLyss/volery/releases/download/v0.54.0/Volery_0.54.0_x64_en-US.msi" },
                { "name": "odd.exe", "size": 5, "browser_download_url": "http://example.com/odd.exe" }
            ]
        });
        let r = release_of(&body).unwrap();
        assert_eq!(r.tag, "v0.54.0");
        assert_eq!(r.assets.len(), 1, "{:?}", r.assets);
        assert_eq!(r.assets[0].size, 18197723);
        assert_eq!(release_of(&json!({ "tag_name": "" })), None);
    }

    #[test]
    fn the_build_queue_is_read_off_githubs_answer() {
        let body = json!({ "workflow_runs": [
            { "head_branch": "v0.54.0", "status": "completed", "conclusion": "success" },
            { "head_branch": "v0.53.0", "status": "completed", "conclusion": "failure" },
            { "head_branch": "v0.55.0", "status": "in_progress", "conclusion": null },
            { "status": "completed" }
        ]});
        let runs = runs_of(&body);
        assert_eq!(runs.len(), 3);
        assert_eq!(runs[2], run("v0.55.0", "in_progress", None));
    }

    /// The workflow this asks about by file name is the one tag pushes run.
    #[test]
    fn the_release_workflow_is_named_rightly() {
        let wf = include_str!("../../.github/workflows/release.yml");
        assert_eq!(RELEASE_WORKFLOW, "release.yml");
        assert!(wf.contains("tags: ['v*']"), "tag pushes are what `event=push` is read as");
        assert!(wf.contains("-setup.exe"), "the release publishes the NSIS installer");
    }

    fn asking() -> Asking {
        Asking {
            machine: "AU-LT-288".into(),
            from: "0.54.0".into(),
            to: "0.55.0".into(),
            installer: "Volery_0.55.0_x64-setup.exe".into(),
            size: "17.4 MB".into(),
            who: "update yourself (ab12cd34), opened from QUEERISFREEDOM".into(),
            busy: 2,
            others_mid: 1,
            copies: 0,
            accepting: true,
            why: Some("Lyss asked from the other laptop".into()),
            overtaken: None,
        }
    }

    /// **The heart of it**: the confirmation is one a person at another wall
    /// can decide. A remote update whose question strands on the far machine is
    /// as useless as no tool at all.
    #[test]
    fn the_confirmation_travels() {
        let a = asking();
        let q = question_of(&a);
        let block = evidence_of(&a).block(&a.machine, &q);
        assert!(crate::ask::confirm_travels(&json!({ "confirm": block.clone() })), "{block}");
        /* It says what the quit dialog would have — that is what lets the yes
           consent for the close too. */
        let facts = block["facts"].to_string();
        assert!(facts.contains("2 cards"), "{facts}");
        assert!(facts.contains("0.55.0"), "{facts}");
        /* The options are the labels the settle reads, exactly. */
        assert_eq!(block["options"][0]["label"], UPDATE_IT);
        assert_eq!(block["options"][1]["label"], NOT_NOW);
    }

    #[test]
    fn the_question_names_what_the_restart_takes_down() {
        let mut a = asking();
        a.copies = 2;
        a.accepting = false;
        a.overtaken = Some("v0.56.0".into());
        let text = question_of(&a)["questions"][0]["question"].as_str().unwrap().to_string();
        for want in ["AU-LT-288", "0.54.0", "0.55.0", "2 cards", "1 other card", "2 other copies", "v0.56.0", "no —"] {
            assert!(text.contains(want), "{want} missing from {text}");
        }
        let block = evidence_of(&a).block(&a.machine, &question_of(&a));
        assert!(crate::ask::confirm_travels(&json!({ "confirm": block })));
    }

    fn underway(to: Option<&str>, launched: bool) -> Underway {
        Underway {
            from: "0.54.0".into(),
            to: to.map(str::to_string),
            asker: Some("update yourself (ab12cd34)".into()),
            installer: Some("Volery_0.55.0_x64-setup.exe".into()),
            launched,
            at: 0,
        }
    }

    /// The morning after: the row says whether it landed, from what the exit
    /// handler left and what this build is.
    #[test]
    fn the_next_launch_says_whether_it_landed() {
        let (level, mark, _) = landing(&underway(Some("0.55.0"), true), "0.55.0", "C:\\u");
        assert_eq!((level, mark.as_str()), ("good", "volery updated 0.54.0 → 0.55.0"));

        let (level, mark, detail) = landing(&underway(Some("0.55.0"), true), "0.54.0", "C:\\u");
        assert_eq!(level, "bad");
        assert!(mark.contains("did not land") && mark.contains("0.55.0"), "{mark}");
        assert!(detail.contains("C:\\u") && detail.contains("Volery_0.55.0"), "{detail}");

        let (_, _, detail) = landing(&underway(Some("0.55.0"), false), "0.54.0", "C:\\u");
        assert!(detail.contains("could not be started"), "{detail}");

        /* The button arms with no `to`, and the row is still honest. */
        let (level, mark, _) = landing(&underway(None, true), "0.55.0", "C:\\u");
        assert_eq!((level, mark.as_str()), ("good", "volery updated 0.54.0 → 0.55.0"));
        let (level, _, _) = landing(&underway(None, true), "0.54.0", "C:\\u");
        assert_eq!(level, "bad");
    }

    /// An underway record round-trips, since the next launch is a different
    /// build reading what this one wrote.
    #[test]
    fn the_record_survives_the_restart_it_describes() {
        let u = underway(Some("0.55.0"), true);
        let back: Underway = serde_json::from_str(&serde_json::to_string(&u).unwrap()).unwrap();
        assert_eq!(back, u);
    }

    /// The watchdog's two traps, held on its text: it waits on the installer
    /// process and never its tree, and it finds the wall by path.
    #[test]
    fn the_watchdog_waits_on_a_process_and_matches_a_path() {
        let src = include_str!("update.rs");
        let script = &src[src.find("const SCRIPT").unwrap()..];
        let script = &script[..script.find("\";").unwrap()];
        assert!(script.contains("WaitForExit("), "{script}");
        assert!(!script.contains("-Wait"), "Start-Process -Wait never returns: sink 92d433d8");
        assert!(script.contains("$_.Path -eq $exe"), "matched by path, never by name");
        assert!(!script.contains("-Name"), "a name matches lab walls too");
    }

    /// The shape github.com actually answers with, probed 2026-08-28:
    /// `HEAD /ShaitanLyss/volery/releases/latest` → `302`,
    /// `Location: https://github.com/ShaitanLyss/volery/releases/tag/v0.14.4`.
    #[test]
    fn the_tag_comes_off_the_redirect() {
        assert_eq!(
            tag_from_location("https://github.com/ShaitanLyss/volery/releases/tag/v0.14.4")
                .as_deref(),
            Some("v0.14.4")
        );
        /* A trailing slash is not a different answer. */
        assert_eq!(
            tag_from_location("https://github.com/o/r/releases/tag/v1.2.3/").as_deref(),
            Some("v1.2.3")
        );
        /* The `v` is left on, because `update.ts` owns stripping it and two
           places deciding what a version looks like is one too many. */
        assert!(tag_from_location("https://github.com/o/r/releases/tag/v1.2.3")
            .is_some_and(|t| t.starts_with('v')));
    }

    /// Every unreadable `Location` is silence rather than a guess — the same
    /// doubt rule the rest of this module is built on. A wrong answer here
    /// downloads four megabytes and closes a wall.
    #[test]
    fn an_unreadable_location_offers_nothing() {
        /* A repository with no releases at all redirects to the index. */
        assert_eq!(tag_from_location("https://github.com/o/r/releases"), None);
        assert_eq!(tag_from_location("https://github.com/o/r/releases/tag/"), None);
        assert_eq!(tag_from_location(""), None);
        assert_eq!(tag_from_location("https://example.com/"), None);
        /* Not a shape github.com produces, and following it would be inventing
           a version out of somebody else's header. */
        assert_eq!(
            tag_from_location("https://github.com/o/r/releases/tag/v1.2.3/extra"),
            None
        );
    }
}
