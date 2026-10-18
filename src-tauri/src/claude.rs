//! Where Claude Code is, whether it is really Claude Code, and how to get one.
//!
//! Every card on this wall is a `claude` child process, so "claude is not on
//! PATH" is the one failure that makes the whole app do nothing — and it is
//! also the one most likely to be a lie. A per-user install that was never
//! added to PATH, a shell that has PATH but a GUI app launched from Explorer
//! that does not, an install under a package manager's own bin directory: all
//! three look identical to `Command::new("claude")` and none of them means the
//! CLI is missing.
//!
//! So: **look before installing.** PATH first, then every directory an install
//! is actually known to land in, and only after all of those come up empty is
//! anything downloaded.
//!
//! ### The trap, and it is a real one
//!
//! `%LOCALAPPDATA%\AnthropicClaude\claude.exe` exists on a machine with the
//! **desktop app** installed and is not the CLI. Probed 2026-08-19 on this
//! machine: it answers `--version` with `1.21459.3`, where the CLI beside it
//! answers `2.1.235 (Claude Code)`. It is a plausible-looking `claude.exe` in a
//! plausible-looking Anthropic directory, it is roughly a third of a megabyte
//! against the CLI's three hundred, and a discovery routine that trusted the
//! filename would spawn it for every card on the wall and get nothing back that
//! anything here can parse.
//!
//! Hence `verify`: a candidate is Claude Code when it *says* it is. `--version`
//! must answer, and the answer must carry the words `Claude Code`. A version
//! number alone is not enough, because the desktop app has one of those.
//!
//! ### Installing
//!
//! `https://claude.ai/install.ps1`, which is the Windows sibling of the
//! `install.sh` the CLI carries a reference to (both strings are in the binary;
//! `install.ps1` appears three times). Run through PowerShell, and **never
//! without being asked for** — `install` is a command the front end calls after
//! putting the question, not something `find` does when it comes up empty. An
//! app that downloads and executes a script from the network because a lookup
//! failed is an app that does that on a typo'd PATH.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

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

/// What a lookup found. `on_path` is carried separately from `path` because the
/// two have different fixes: a CLI that is present but off PATH wants a line in
/// a profile, not a download, and telling the difference is the whole point of
/// this module.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    /// Absolute path to the binary that answered. Spawn *this*, not the bare
    /// name — the bare name is what was already tried and failed.
    pub path: String,
    pub version: String,
    /// Whether the bare name `claude` resolves to it. False means installed but
    /// invisible to a plain `Command::new("claude")`.
    pub on_path: bool,
    /// Which of the known homes this came out of, for the sentence the front
    /// end draws. Never a guess — the name of the branch that matched.
    pub found_in: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum Presence {
    /// Found and verified.
    Ready(Found),
    /// Nothing anywhere. The only state in which installing is the answer.
    Missing { looked_in: Vec<String> },
}

/// The executable names an install can wear on this platform. `.cmd` and `.bat`
/// are the npm-global shapes — a shim script rather than an exe — and
/// `Command` runs them the same way.
#[cfg(windows)]
const NAMES: [&str; 4] = ["claude.exe", "claude.cmd", "claude.bat", "claude"];
#[cfg(not(windows))]
const NAMES: [&str; 1] = ["claude"];

/// Does this path answer `--version`, and does it say it is Claude Code?
///
/// The second half is the desktop-app trap in the module note. Matched
/// case-insensitively on the words rather than on a version shape, because a
/// version shape is exactly what the wrong binary also has.
///
/// A one-off `--version` on a 300MB binary is not free, so this runs on a
/// candidate list that is short by construction and its answer is worth
/// caching by the caller.
pub fn verify(path: &Path) -> Option<String> {
    let out = quiet(Command::new(path).arg("--version")).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let said = String::from_utf8_lossy(&out.stdout);
    let said = said.trim();
    if !said.to_lowercase().contains("claude code") {
        return None;
    }
    Some(said.to_string())
}

/// The directories an install is actually known to land in, with the name of
/// each so a find can say where it came from.
///
/// Deliberately **not** including `%LOCALAPPDATA%\AnthropicClaude` — that is
/// the desktop app's directory, and while `verify` would reject what is in it,
/// listing it here would put "we looked in the desktop app's folder" in the
/// not-found message and send somebody to reinstall the wrong product.
fn homes(home: &Path) -> Vec<(String, PathBuf)> {
    let mut out = vec![
        /* The native installer, which is what `claude install` and install.ps1
           both produce. Versions live under ~/.local/share/claude/versions and
           this is the shim that picks one. */
        ("the native install".to_string(), home.join(".local").join("bin")),
        /* The older local install, kept because a machine that has been through
           several CLI versions may still be running off it. */
        ("a local install".to_string(), home.join(".claude").join("local")),
        ("a bun global install".to_string(), home.join(".bun").join("bin")),
    ];
    #[cfg(windows)]
    {
        out.push((
            "an npm global install".to_string(),
            home.join("AppData").join("Roaming").join("npm"),
        ));
    }
    #[cfg(not(windows))]
    {
        out.push(("an npm global install".to_string(), home.join(".npm-global").join("bin")));
        out.push(("a homebrew install".to_string(), PathBuf::from("/opt/homebrew/bin")));
        out.push(("a system install".to_string(), PathBuf::from("/usr/local/bin")));
    }
    out
}

/// The first verified `claude` on PATH, if any.
///
/// Walked by hand rather than shelled out to `where`/`which`, for two reasons:
/// every candidate still has to go through `verify` regardless, and `where` on
/// Windows would pop a console window per call unless wrapped in the same
/// `quiet` — at which point it is more code than the walk.
fn on_path() -> Option<(PathBuf, String)> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for name in NAMES {
            let candidate = dir.join(name);
            if !candidate.is_file() {
                continue;
            }
            if let Some(v) = verify(&candidate) {
                return Some((candidate, v));
            }
        }
    }
    None
}

/// Where Claude Code is on this machine, or a list of everywhere that was
/// looked.
///
/// PATH first, because a CLI on PATH is one every other tool on the machine
/// already agrees about and is the only case where spawning the bare name
/// works. Then the known homes in the order above.
pub fn find(home: &Path) -> Presence {
    if let Some((path, version)) = on_path() {
        return Presence::Ready(Found {
            path: path.to_string_lossy().into_owned(),
            version,
            on_path: true,
            found_in: "PATH".into(),
        });
    }

    let mut looked = vec!["PATH".to_string()];
    for (what, dir) in homes(home) {
        looked.push(dir.to_string_lossy().into_owned());
        for name in NAMES {
            let candidate = dir.join(name);
            if !candidate.is_file() {
                continue;
            }
            if let Some(version) = verify(&candidate) {
                return Presence::Ready(Found {
                    path: candidate.to_string_lossy().into_owned(),
                    version,
                    on_path: false,
                    found_in: what,
                });
            }
        }
    }
    Presence::Missing { looked_in: looked }
}

/* ── what to actually spawn ────────────────────────────────────────────────*/

/// The resolved program name for every card on the wall, worked out once.
///
/// `Command::new("claude")` is what this used to be, and it is wrong on exactly
/// the machine this module exists for: a CLI installed by the native installer
/// but never added to PATH makes every card on the wall fail to spawn, with a
/// message saying the program was not found and a user who can see the binary
/// sitting in `~/.local/bin`. `find` already knows where it is, so a spawn
/// should use what it found.
///
/// Cached because `verify` runs the 300MB binary to ask its version, and doing
/// that per card per wake would be a visible cost for an answer that changes
/// about once a month. `OnceLock` rather than a refreshable cache: an install
/// that appears while Skein is running is picked up on the next launch, and the
/// alternative — re-probing on every spawn in case — buys a rare case at every
/// card's expense. `forget_program` exists so the install flow can drop it,
/// which is the one time the answer changes under a running app.
static PROGRAM: std::sync::OnceLock<String> = std::sync::OnceLock::new();

pub fn program(home: &Path) -> String {
    PROGRAM
        .get_or_init(|| match find(home) {
            Presence::Ready(f) => f.path,
            /* Nothing found: still spawn the bare name. The failure that
               produces is the one the user already understands, and it keeps
               this from being able to make things *worse* than before. */
            Presence::Missing { .. } => "claude".to_string(),
        })
        .clone()
}

/// What the front end asks on startup and from the accounts panel.
#[tauri::command]
pub async fn find_claude(app: tauri::AppHandle) -> Result<Presence, String> {
    use tauri::Manager;
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("no home dir: {e}"))?;
    crate::off_main(move || find(&home)).await
}

/// Download and run the official installer.
///
/// **Only ever from an explicit gesture.** Nothing in `find` calls this, and
/// nothing on the startup path calls it either: a lookup coming up empty is a
/// question to put to somebody, not a licence to execute a script off the
/// network. The front end asks first.
///
/// Blocking, and can take a couple of minutes on a slow link — hence
/// `off_main`, the same reason `read_limits` is there.
#[tauri::command]
pub async fn install_claude() -> Result<String, String> {
    crate::off_main(install).await?
}

fn install() -> Result<String, String> {
    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new("powershell");
        c.args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "irm https://claude.ai/install.ps1 | iex",
        ]);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = Command::new("sh");
        c.args(["-c", "curl -fsSL https://claude.ai/install.sh | sh"]);
        c
    };

    let out = quiet(&mut cmd)
        .output()
        .map_err(|e| format!("could not run the installer: {e}"))?;
    if !out.status.success() {
        /* stderr, trimmed to something that fits a fault line. The installer is
           chatty on success and terse on failure, so the tail is the part that
           says what went wrong. */
        let said = String::from_utf8_lossy(&out.stderr);
        let tail: String = said.lines().rev().take(3).collect::<Vec<_>>().join(" ");
        return Err(if tail.trim().is_empty() {
            "the installer failed and said nothing".into()
        } else {
            format!("the installer failed: {}", tail.trim())
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("installed")
        .trim()
        .to_string())
}

/// Whether the machine's own Claude Code is signed in — the credential a card
/// spawns as when it is on no account Volery manages. Mirrors the parts of
/// `claude auth status --json` the empty state reads.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Auth {
    pub logged_in: bool,
    /// `claude.ai`, `none`, or whatever else the CLI names its method.
    pub method: String,
    /// `subscriptionType` — `max`, `pro`, `team` — when signed in to one.
    pub plan: Option<String>,
}

/// Read what `auth status --json` printed. `None` for anything that is not the
/// record, so a CLI that changed its shape reads as "could not tell" rather
/// than as signed out.
pub fn read_auth(said: &str) -> Option<Auth> {
    let v: serde_json::Value = serde_json::from_str(said.trim()).ok()?;
    let logged_in = v.get("loggedIn")?.as_bool()?;
    Some(Auth {
        logged_in,
        method: v
            .get("authMethod")
            .and_then(|m| m.as_str())
            .unwrap_or("none")
            .to_string(),
        plan: v
            .get("subscriptionType")
            .and_then(|m| m.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string),
    })
}

/// Ask the CLI whether it is signed in, without a turn.
///
/// `tools/probe-auth.ts` is why this is the question and why the exit code is
/// ignored: signed out exits **1** with a perfectly good record on stdout, and
/// a reader that took a non-zero exit as "could not ask" would call a
/// newcomer's machine broken rather than signed out. Spawned in Volery's own
/// environment, which is the one an unmanaged card inherits — nothing set,
/// nothing removed — so the answer is about the card that would spawn. About a
/// second a call (the probe, 2.1.288), so the front end asks when the empty
/// state is drawn and on *look again*, never on a timer.
pub fn auth_status(home: &Path) -> Result<Auth, String> {
    use std::process::Stdio;
    let mut cmd = Command::new(program(home));
    cmd.args(["auth", "status", "--json"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    quiet(&mut cmd);
    let child = cmd
        .spawn()
        .map_err(|e| format!("could not ask claude code: {e}"))?;
    /* In a job like every other spawn, though this one exits on its own in a
       second: what the promise "children die with the app" is worth is what
       the job holds (`CLAUDE.md`). */
    let job = crate::servers::jobs::Job::new();
    if let Some(j) = &job {
        j.assign(child.id());
    }
    let out = child
        .wait_with_output()
        .map_err(|e| format!("could not ask claude code: {e}"))?;
    read_auth(&String::from_utf8_lossy(&out.stdout))
        .ok_or_else(|| "claude code did not say whether it is signed in".to_string())
}

/// What chat view's empty state asks before the first message (§5.9).
#[tauri::command]
pub async fn claude_auth(app: tauri::AppHandle) -> Result<Auth, String> {
    use tauri::Manager;
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("no home dir: {e}"))?;
    crate::off_main(move || auth_status(&home)).await?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The desktop app answers `--version` with a bare number and no product
    /// name; the CLI answers `2.1.235 (Claude Code)`. Probed 2026-08-19. This
    /// is the discrimination `verify` rests on, tested against the two real
    /// strings rather than against the binaries.
    fn says_claude_code(said: &str) -> bool {
        said.to_lowercase().contains("claude code")
    }

    #[test]
    fn the_cli_is_recognised() {
        assert!(says_claude_code("2.1.235 (Claude Code)"));
    }

    #[test]
    fn the_desktop_app_is_not() {
        assert!(!says_claude_code("1.21459.3"));
    }

    #[test]
    fn a_bare_version_is_never_enough() {
        assert!(!says_claude_code("2.1.235"));
    }

    #[test]
    fn the_desktop_directory_is_not_searched() {
        let home = PathBuf::from("C:/Users/x");
        let dirs: Vec<String> = homes(&home)
            .into_iter()
            .map(|(_, d)| d.to_string_lossy().to_lowercase())
            .collect();
        assert!(
            dirs.iter().all(|d| !d.contains("anthropicclaude")),
            "the desktop app's directory must not be in the search, or a \
             not-found message sends somebody to reinstall the wrong product"
        );
    }

    /// The two records `tools/probe-auth.ts` read off claude 2.1.288, less the
    /// fields it redacts.
    #[test]
    fn a_signed_in_record_reads_signed_in_with_its_plan() {
        let said = r#"{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"team"}"#;
        assert_eq!(
            read_auth(said),
            Some(Auth { logged_in: true, method: "claude.ai".into(), plan: Some("team".into()) })
        );
    }

    #[test]
    fn a_signed_out_record_reads_signed_out() {
        let said = r#"{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty","configDirectory":"C:\\Users\\x\\.claude"}"#;
        assert_eq!(
            read_auth(said),
            Some(Auth { logged_in: false, method: "none".into(), plan: None })
        );
    }

    #[test]
    fn anything_else_is_could_not_tell_rather_than_signed_out() {
        assert_eq!(read_auth(""), None);
        assert_eq!(read_auth("error: unknown command 'auth'"), None);
        assert_eq!(read_auth(r#"{"authMethod":"none"}"#), None);
    }
}
