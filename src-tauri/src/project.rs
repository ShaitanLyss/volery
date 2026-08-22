//! What a project *is*, and what it is doing.
//!
//! Two questions, answered at two very different rates. What a project *is* —
//! a package.json with a `build` script, a `.uproject` whose engine lives at
//! `C:\Program Files\Epic Games\UE_5.8` — is read once, when the territory
//! appears on the wall. What it is *doing* — is its editor up, is the branch
//! ahead of its remote — is re-read on a slow poll, because both change while
//! you are looking at them.
//!
//! Everything here answers in *facts*. Which verbs those facts add up to is
//! decided in `src/lib/actions.ts`, which is pure and tested; this file must
//! never grow an opinion about what a build is.
//!
//! One question sits between the two: what the *remote* has. Nothing on disk
//! knows, and asking costs a network round trip per repo — so it is neither
//! probed once nor folded into the poll. `fetch_projects` is its own
//! fire-and-forget command on its own much slower clock, and it leaves its
//! answer where the ordinary poll already reads: the remote-tracking refs, and
//! so `behind`.
//!
//! The one thing worth knowing about the poll: finding out whether *this*
//! project's editor is open is expensive done properly. The proper way is the
//! process command line (another project's `UnrealEditor.exe` must never
//! receive our compile triggers), and on Windows that means WMI, which means a
//! PowerShell spawn of a few hundred milliseconds. So the cheap answer is tried
//! first — a top-level window of class `UnrealWindow` whose title carries the
//! project name, which costs one `EnumWindows` — and the expensive one only
//! runs when that finds nothing, at most once every 15 seconds.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/* ── no console windows ────────────────────────────────────────────────────
 *
 * Every helper here shells out to something, and a GUI app spawning a console
 * program flashes a black window on screen unless it says not to. */
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

fn output(cmd: &mut Command) -> Option<String> {
    let out = quiet(cmd).output().ok()?;
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/* ── what a project is ────────────────────────────────────────────────────── */

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnrealFacts {
    pub uproject: String,
    pub name: String,
    pub engine: Option<String>,
    pub mcp_port: Option<u16>,
    pub log: String,
}

#[derive(Clone, Serialize)]
pub struct ProjectFacts {
    pub root: String,
    /// "pnpm" | "npm" | "yarn" | "bun"
    pub manager: String,
    pub scripts: Vec<String>,
    pub node: bool,
    pub tauri: bool,
    pub cargo: bool,
    pub git: bool,
    pub unreal: Option<UnrealFacts>,
    /// Every file at or under the root that declares this project's version.
    /// Whether any of it adds up to a project worth offering a bump to is
    /// decided in `actions.ts`, not here.
    pub versions: Vec<VersionFile>,
}

/// Which package manager this repo is written for.
///
/// A lockfile is the strongest evidence there is — it exists because somebody
/// ran that manager here. `packageManager` is a declaration and comes first
/// anyway, since it is the thing a repo says on purpose. With neither, the
/// answer is **pnpm**: npm is what gets typed out of habit, not chosen.
fn manager_for(root: &Path, pkg: Option<&serde_json::Value>) -> String {
    if let Some(field) = pkg
        .and_then(|p| p.get("packageManager"))
        .and_then(|v| v.as_str())
    {
        let name = field.split('@').next().unwrap_or("").trim().to_lowercase();
        if matches!(name.as_str(), "pnpm" | "npm" | "yarn" | "bun") {
            return name;
        }
    }
    for (file, mgr) in [
        ("bun.lock", "bun"),
        ("bun.lockb", "bun"),
        ("pnpm-lock.yaml", "pnpm"),
        ("yarn.lock", "yarn"),
        ("package-lock.json", "npm"),
    ] {
        if root.join(file).exists() {
            return mgr.into();
        }
    }
    "pnpm".into()
}

/// The `.uproject` at or above `root`, if there is one.
///
/// Upward as well as at the root because what gets opened on the wall is a
/// folder you were working in, which for a big project is often `Source/` or a
/// plugin, not the directory holding the `.uproject`.
fn find_uproject(root: &Path) -> Option<PathBuf> {
    let mut at = Some(root);
    for _ in 0..5 {
        let dir = at?;
        if let Ok(entries) = std::fs::read_dir(dir) {
            let mut hits: Vec<PathBuf> = entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| {
                    p.extension()
                        .map(|e| e.eq_ignore_ascii_case("uproject"))
                        .unwrap_or(false)
                })
                .collect();
            /* Stable: two .uproject files in one directory is unusual but a
               different answer every launch would be worse than the wrong one. */
            hits.sort();
            if let Some(first) = hits.into_iter().next() {
                return Some(first);
            }
        }
        at = dir.parent();
    }
    None
}

/// Where the engine this project is associated with is installed.
///
/// `EngineAssociation` comes in two forms, and they live in two different
/// hives: a launcher install is a version string under HKLM, and anything
/// registered by UnrealVersionSelector — including every source build — is a
/// GUID under HKCU. `reg query` rather than a registry crate, because this runs
/// once per project and a dependency is a poor trade for that.
fn engine_root(uproject: &Path) -> Option<String> {
    let text = std::fs::read_to_string(uproject).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    let assoc = json
        .get("EngineAssociation")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    if !assoc.is_empty() {
        let out = if assoc.starts_with('{') {
            output(Command::new("reg").args([
                "query",
                r"HKCU\SOFTWARE\Epic Games\Unreal Engine\Builds",
                "/v",
                &assoc,
            ]))
        } else {
            output(Command::new("reg").args([
                "query",
                &format!(r"HKLM\SOFTWARE\EpicGames\Unreal Engine\{assoc}"),
                "/v",
                "InstalledDirectory",
            ]))
        };
        if let Some(dir) = out.as_deref().and_then(parse_reg_sz) {
            let dir = dir.replace('/', "\\");
            if Path::new(&dir).is_dir() {
                return Some(dir);
            }
        }
        if !assoc.starts_with('{') {
            let default = format!(r"C:\Program Files\Epic Games\UE_{assoc}");
            if Path::new(&default).is_dir() {
                return Some(default);
            }
        }
    }

    /* A project sitting inside an engine tree has an empty association, and
       nothing in the registry will ever answer for it. The engine is simply
       above it. */
    let mut at = uproject.parent();
    for _ in 0..6 {
        let dir = at?;
        if dir
            .join("Engine")
            .join("Build")
            .join("BatchFiles")
            .join("Build.bat")
            .exists()
        {
            return Some(dir.to_string_lossy().into_owned());
        }
        at = dir.parent();
    }
    None
}

/// The value out of `reg query` output: `    InstalledDirectory    REG_SZ    C:\…`
fn parse_reg_sz(out: &str) -> Option<String> {
    for line in out.lines() {
        if let Some(at) = line.find("REG_SZ") {
            let value = line[at + "REG_SZ".len()..].trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

/// The port this *repo* declares in its committed `.mcp.json`.
///
/// The source of truth on purpose: the editor's own `ServerPortNumber` lives in
/// `Saved/Config`, which is per-machine and does not survive a clone, so a
/// fresh checkout would come up on the default port while `.mcp.json` still
/// pointed somewhere else — silent, and it reads as the agent's fault.
fn mcp_port(root: &Path) -> Option<u16> {
    let text = std::fs::read_to_string(root.join(".mcp.json")).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    for (_, server) in json.get("mcpServers")?.as_object()? {
        let Some(url) = server.get("url").and_then(|v| v.as_str()) else {
            continue;
        };
        /* http://127.0.0.1:7245/mcp → 7245 */
        let after_scheme = url.split("//").nth(1)?;
        let host = after_scheme.split('/').next()?;
        if let Some(port) = host.rsplit(':').next().and_then(|p| p.parse().ok()) {
            return Some(port);
        }
    }
    None
}

/* ── what version a project is on ──────────────────────────────────────────
 *
 * Four shapes, and a version lives in a different place in each. This is the
 * one thing in this file that both reads *and* writes, which looks like the
 * "facts, never verbs" rule being broken and is not: where a version lives in a
 * file of a given shape is a single fact, and reading it and setting it are that
 * fact expressed twice. Splitting them would put the same format knowledge in
 * two files, which is the worse trade. What *level* to bump to, what the commit
 * says and what the tag is called are decided in `actions.ts`; whether it is
 * allowed to happen at all is `actions.rs`. Nothing here decides anything.
 *
 * Every write is a **line-based text edit**, never a re-serialize. Round-tripping
 * a package.json through serde_json reorders its keys and reformats every line
 * of it, so a two-character version bump would arrive as a diff of the whole
 * file — and `serde_json`'s map is a `BTreeMap` unless the `preserve_order`
 * feature is on, so the reordering is not even avoidable. Replacing the value in
 * place leaves a one-line diff, which is what the log already has for every
 * release this repo has made.
 *
 * "vite" is deliberately not one of the shapes. A Vite app's version *is* its
 * package.json's — `vite.config.ts` has no version field, and the
 * `__APP_VERSION__` define people write there reads package.json at build time. */

/// One file that declares this project's version.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionFile {
    /// Relative to the root, forward-slashed. This is what a tooltip names and
    /// what `git commit --` is handed, so it has to be a path git accepts —
    /// which rules out anything above the root, and is why nothing here looks
    /// upwards the way `find_uproject` does.
    pub path: String,
    /// The shape, not the filename: "json" | "toml" | "ini" | "lock". The
    /// writer switches on this and the reader already has.
    pub kind: String,
    /// What it says now, verbatim — including things that are not versions at
    /// all. Tauri lets `version` be a *path* to a package.json, and a Cargo
    /// crate can inherit one from its workspace; neither is a number, and
    /// deciding that is `actions.ts`'s job rather than this file's.
    pub version: String,
}

/// A top-level `"version"` in a JSON file, at brace depth 1.
///
/// Depth-tracked rather than handed to `serde_json`, so that the reader and the
/// writer below agree by construction: a `"version"` nested inside some other
/// object is not this project's version, and if the two disagreed about which
/// one they had found a bump would rewrite a field nobody asked about.
fn json_version(text: &str) -> Option<String> {
    json_line(text).map(|(_, v)| v)
}

/// `(line index, value)` of the top-level `"version"`.
///
/// Braces inside strings are skipped, which is not fussiness: `package.json`'s
/// own `test` script in this repository is a single line naming fifty files, and
/// a brace anywhere in a script value would put the depth count out for every
/// line after it. Cheaper to count correctly than to rely on `version` always
/// appearing near the top.
fn json_line(text: &str) -> Option<(usize, String)> {
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for (i, line) in text.lines().enumerate() {
        /* The key is looked for at the depth this line *opens* at, so the
           `{` of the root object does not have to be on a line of its own. */
        let at_root = depth == 1 && !in_string;
        if at_root {
            if let Some(value) = quoted_value(line, "\"version\"") {
                return Some((i, value));
            }
        }
        for c in line.chars() {
            if escaped {
                escaped = false;
            } else if in_string {
                match c {
                    '\\' => escaped = true,
                    '"' => in_string = false,
                    _ => {}
                }
            } else {
                match c {
                    '"' => in_string = true,
                    '{' | '[' => depth += 1,
                    '}' | ']' => depth = depth.saturating_sub(1),
                    _ => {}
                }
            }
        }
        /* A newline ends any string JSON allows, so a stray quote cannot make
           the rest of the file invisible. */
        in_string = false;
        escaped = false;
    }
    None
}

/// `"version": "0.7.0",` → `0.7.0`, given the key. `None` if this line is not
/// that key, or carries something other than a quoted string.
fn quoted_value(line: &str, key: &str) -> Option<String> {
    let rest = line.trim_start().strip_prefix(key)?;
    let rest = rest.trim_start().strip_prefix(':')?;
    let rest = rest.trim_start();
    let inner = rest.strip_prefix('"')?;
    let end = inner.find('"')?;
    Some(inner[..end].to_string())
}

/// A `[package]` section's `version = "…"`.
///
/// Only inside `[package]`: `[package.metadata.…]` is a different section and a
/// `[dependencies]` entry's version is somebody else's crate. A
/// `version.workspace = true` carries no quoted string and so is not found,
/// which is the right answer — a version inherited from a workspace is not
/// this file's to set.
fn toml_package_version(text: &str) -> Option<String> {
    toml_line(text, "version").map(|(_, v)| v)
}

fn toml_line(text: &str, key: &str) -> Option<(usize, String)> {
    let mut in_package = false;
    for (i, line) in text.lines().enumerate() {
        let t = line.trim();
        if t.starts_with('[') {
            in_package = t == "[package]";
            continue;
        }
        if !in_package {
            continue;
        }
        if let Some(value) = bare_value(t, key) {
            return Some((i, value));
        }
    }
    None
}

/// `version = "0.7.0"` → `0.7.0`. TOML and ini both, since `=` is `=`.
fn bare_value(line: &str, key: &str) -> Option<String> {
    let rest = line.strip_prefix(key)?;
    let rest = rest.trim_start().strip_prefix('=')?.trim();
    match rest.strip_prefix('"') {
        Some(inner) => inner.find('"').map(|end| inner[..end].to_string()),
        /* An ini value is unquoted: `ProjectVersion=1.0.0.0`. Anything after a
           `;` on the line is a comment. */
        None => {
            let value = rest.split(';').next()?.trim();
            (!value.is_empty()).then(|| value.to_string())
        }
    }
}

/// `ProjectVersion=1.0.0.0` out of an Unreal `DefaultGame.ini`.
///
/// Not section-scoped. The key belongs to
/// `[/Script/EngineSettings.GeneralProjectSettings]` and appears nowhere else in
/// any ini Unreal ships, and matching on the section name would mean carrying
/// that string here to no purpose.
fn ini_project_version(text: &str) -> Option<String> {
    text.lines()
        .find_map(|line| bare_value(line.trim(), "ProjectVersion"))
}

/// A `[[package]]` entry's version in a `Cargo.lock`, found by crate name.
///
/// Worth mending rather than leaving to the next `cargo build`, which is what
/// the alternative amounts to: a bump commit that left the lock stale would be
/// followed immediately by a dirty tree, one line different, on a tag that
/// claims to be a release. `cargo` writes exactly this line itself.
fn lock_line(text: &str, crate_name: &str) -> Option<(usize, String)> {
    let want = format!("name = \"{crate_name}\"");
    let lines: Vec<&str> = text.lines().collect();
    let mut found = false;
    for (i, line) in lines.iter().enumerate() {
        let t = line.trim();
        if t == "[[package]]" {
            found = false;
            continue;
        }
        if t == want {
            found = true;
            continue;
        }
        if found {
            if let Some(value) = bare_value(t, "version") {
                return Some((i, value));
            }
            /* The version is written directly under the name by cargo; a block
               that does not have it there is not one we can mend. */
            if t.starts_with('[') || t.is_empty() {
                found = false;
            }
        }
    }
    None
}

/// A `[package]` section's `name`.
fn toml_package_name(text: &str) -> Option<String> {
    toml_line(text, "name").map(|(_, v)| v)
}

/// Replace one line's value and leave every other byte of the file alone.
///
/// The line's own indentation, its trailing comma, its comment and the file's
/// line endings all survive, because only the span between the value's quotes
/// — or between the `=` and the end of the value — is touched.
fn splice(text: &str, line_no: usize, was: &str, to: &str) -> Option<String> {
    let mut out = String::with_capacity(text.len() + 8);
    let mut done = false;
    /* Split keeping the endings, so a CRLF file stays a CRLF file. */
    let mut at = 0usize;
    let mut i = 0usize;
    while at < text.len() {
        let end = text[at..].find('\n').map(|n| at + n + 1).unwrap_or(text.len());
        let line = &text[at..end];
        if i == line_no {
            let cut = line.find(was)?;
            out.push_str(&line[..cut]);
            out.push_str(to);
            out.push_str(&line[cut + was.len()..]);
            done = true;
        } else {
            out.push_str(line);
        }
        at = end;
        i += 1;
    }
    done.then_some(out)
}

/// What this file says now and what it would say with its version set to `to`,
/// or `None` if the field it was found by is no longer there.
///
/// Both halves are returned because `actions.rs` needs both. The new text is
/// obvious; the old value is how a *stale* plan is caught â€” the facts a chip's
/// tooltip was built from are probed once, when the territory appears, so a
/// version edited by hand or by another card since then would otherwise be
/// overwritten by arithmetic done on a number that is no longer there. Going
/// backwards over an existing tag is the failure that guards against.
///
/// Returning `None` rather than writing something is load-bearing for the same
/// reason: `actions.rs` asks every file *before* writing any of them, so a shape
/// it cannot edit refuses the whole bump with nothing half-written.
pub(crate) fn set_version(kind: &str, text: &str, to: &str) -> Option<(String, String)> {
    let found = match kind {
        "json" => json_line(text),
        "toml" => toml_line(text, "version"),
        "ini" => {
            let (i, v) = text
                .lines()
                .enumerate()
                .find_map(|(i, l)| bare_value(l.trim(), "ProjectVersion").map(|v| (i, v)))?;
            Some((i, v))
        }
        "lock" => {
            /* The crate name is not carried in the plan — a lock is mended
               beside the `Cargo.toml` that names it, and `version_files` is
               what pairs them up. */
            return None;
        }
        _ => None,
    }?;
    let next = splice(text, found.0, &found.1, to)?;
    Some((found.1, next))
}

/// The same, for a `Cargo.lock` entry that has to be found by crate name.
pub(crate) fn set_lock_version(
    text: &str,
    crate_name: &str,
    to: &str,
) -> Option<(String, String)> {
    let (line, was) = lock_line(text, crate_name)?;
    let next = splice(text, line, &was, to)?;
    Some((was, next))
}

/// Every version-declaring file at or under `root`.
///
/// `src-tauri/Cargo.toml` is read as well as the root's, because for a Tauri app
/// that is where the crate version lives and it is kept in lockstep with
/// `tauri.conf.json` — this repository's own `skein: 0.7.0` commit moved
/// package.json, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` and
/// `src-tauri/tauri.conf.json` together, which is the case this was written
/// against and tested on.
///
/// `unreal_root` is passed in rather than looked up, and only when it is at or
/// under `root`: `find_uproject` searches *upwards*, since what gets opened on
/// the wall is often `Source/`, and a `Config/DefaultGame.ini` above the root is
/// a path `git commit --` cannot be handed from here.
fn version_files(root: &Path, unreal_root: Option<&Path>) -> Vec<VersionFile> {
    let mut out: Vec<VersionFile> = Vec::new();

    let read = |rel: &str| -> Option<String> { std::fs::read_to_string(root.join(rel)).ok() };

    for rel in ["package.json", "src-tauri/tauri.conf.json"] {
        if let Some(v) = read(rel).as_deref().and_then(json_version) {
            out.push(VersionFile {
                path: rel.into(),
                kind: "json".into(),
                version: v,
            });
        }
    }

    for rel in ["Cargo.toml", "src-tauri/Cargo.toml"] {
        let Some(text) = read(rel) else { continue };
        let Some(v) = toml_package_version(&text) else {
            continue;
        };
        out.push(VersionFile {
            path: rel.into(),
            kind: "toml".into(),
            version: v.clone(),
        });
        /* And the lock beside it, if it holds an entry for this crate. */
        let lock = rel.replace("Cargo.toml", "Cargo.lock");
        let Some(name) = toml_package_name(&text) else {
            continue;
        };
        if let Some(found) = read(&lock)
            .as_deref()
            .and_then(|t| lock_line(t, &name))
        {
            out.push(VersionFile {
                path: lock,
                kind: "lock".into(),
                version: found.1,
            });
        }
    }

    if let Some(up) = unreal_root {
        if let Ok(rel) = up.strip_prefix(root) {
            let ini = if rel.as_os_str().is_empty() {
                "Config/DefaultGame.ini".to_string()
            } else {
                format!("{}/Config/DefaultGame.ini", rel.to_string_lossy().replace('\\', "/"))
            };
            if let Some(v) = read(&ini).as_deref().and_then(ini_project_version) {
                out.push(VersionFile {
                    path: ini,
                    kind: "ini".into(),
                    version: v,
                });
            }
        }
    }

    out
}

/// Which crate a `Cargo.lock` entry belongs to, for `bump_version` to mend it
/// with. Read off the `Cargo.toml` beside it rather than carried through the
/// plan, since the plan is about versions and this is about the file.
pub(crate) fn lock_crate(root: &Path, lock_rel: &str) -> Option<String> {
    let toml = lock_rel.replace("Cargo.lock", "Cargo.toml");
    toml_package_name(&std::fs::read_to_string(root.join(toml)).ok()?)
}

#[tauri::command]
pub async fn probe_project(root: String) -> ProjectFacts {
    let dir = PathBuf::from(&root);

    let pkg: Option<serde_json::Value> = std::fs::read_to_string(dir.join("package.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok());

    let mut scripts: Vec<String> = pkg
        .as_ref()
        .and_then(|p| p.get("scripts"))
        .and_then(|s| s.as_object())
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default();
    scripts.sort();

    let tauri = dir.join("src-tauri").join("tauri.conf.json").exists()
        || scripts.iter().any(|s| s == "tauri");

    let uproject = find_uproject(&dir);
    /* Where `Config/DefaultGame.ini` would be, for the version scan. Kept out
       here because `unreal` moves the path into itself. */
    let unreal_root = uproject.as_ref().and_then(|up| up.parent()).map(|p| p.to_path_buf());

    let unreal = uproject.map(|up| {
        let name = up
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let project_root = up.parent().unwrap_or(&dir).to_path_buf();
        UnrealFacts {
            log: project_root
                .join("Saved")
                .join("Logs")
                .join(format!("{name}.log"))
                .to_string_lossy()
                .into_owned(),
            engine: engine_root(&up),
            mcp_port: mcp_port(&project_root),
            uproject: up.to_string_lossy().into_owned(),
            name,
        }
    });

    ProjectFacts {
        manager: manager_for(&dir, pkg.as_ref()),
        node: pkg.is_some(),
        scripts,
        tauri,
        /* The root's own Cargo.toml. `src-tauri/Cargo.toml` is part of a Tauri
           project rather than a project of its own, and offering `cargo build`
           for it would build the back end without the front end it needs. */
        cargo: dir.join("Cargo.toml").exists(),
        /* A file, not only a directory: that is what a git worktree has, and
           worktrees are how half the cards on this wall get opened. */
        git: dir.join(".git").exists(),
        versions: version_files(&dir, unreal_root.as_deref()),
        unreal,
        root,
    }
}

/* ── what a project is doing ──────────────────────────────────────────────── */

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PollRequest {
    pub root: String,
    /// The Unreal project name to look for a running editor of, if this is one.
    pub unreal_name: Option<String>,
    pub git: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectStatus {
    pub root: String,
    pub editor_pid: Option<u32>,
    pub branch: Option<String>,
    pub upstream: bool,
    pub ahead: u32,
    pub behind: u32,
    pub dirty: bool,
    /// How many files are in conflict.
    pub conflicts: u32,
    /// The first few of them, for a tooltip. Capped, because a bad merge of a
    /// generated tree is thousands of paths and nothing draws them.
    pub conflict_paths: Vec<String>,
    /// What is half-done: "merge" | "rebase" | "cherry-pick" | "revert". Only
    /// asked for while there are conflicts, since it costs a second spawn.
    pub operation: Option<String>,
}

/// Everything one `git status --porcelain=v2 --branch` amounts to.
#[derive(Default)]
struct Git {
    branch: Option<String>,
    upstream: bool,
    ahead: u32,
    behind: u32,
    dirty: bool,
    conflicts: u32,
    conflict_paths: Vec<String>,
    operation: Option<String>,
}

/// How many conflicted paths are worth carrying to the front end.
const MAX_CONFLICT_PATHS: usize = 8;

/// One `git` call for branch, tracking, distance and cleanliness together.
///
/// `--porcelain=v2 --branch` answers all of it; asking separately would be four
/// process spawns per project per poll, which on a wall of a dozen projects is
/// a great deal of nothing happening.
///
/// Two flags are about the cost of asking this every few seconds. `-uno` skips
/// the untracked scan, which on an Unreal project — `Saved/`, `Intermediate/`,
/// `DerivedDataCache/`, hundreds of thousands of files — is essentially the
/// whole of what status costs, and answers a question the push chip never asks.
/// `--no-optional-locks` stops it refreshing the index, so a poll can never
/// collide with a commit you are making in a terminal.
///
/// Note this is entirely local: `behind` is measured against the
/// remote-tracking ref as it was left by the last fetch, so it is only ever as
/// current as `fetch_projects` has made it. That separation is the point — the
/// poll stays cheap and offline, and the network call has its own much slower
/// clock.
fn git_status(root: &str) -> Git {
    let Some(out) = output(Command::new("git").current_dir(root).args([
        "--no-optional-locks",
        "status",
        "--porcelain=v2",
        "--branch",
        "-uno",
    ])) else {
        return Git::default();
    };
    let mut g = parse_status(&out);
    /* Only now, and only while there is something half-done to name: it is a
       second spawn, and `u` lines are the cheap way to know it is worth it. */
    if g.conflicts > 0 {
        g.operation = git_operation(root);
    }
    g
}

fn parse_status(out: &str) -> Git {
    let mut g = Git::default();

    for line in out.lines() {
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            let name = rest.trim();
            /* Detached HEAD reports `(detached)`, which is not a branch and
               must not become one on a chip. */
            if name != "(detached)" {
                g.branch = Some(name.to_string());
            }
        } else if line.starts_with("# branch.upstream ") {
            g.upstream = true;
        } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            /* `+1 -2` — ahead of the upstream by one commit, behind it by two.
               Both signs are always present when the header is at all, and the
               header only appears when there *is* an upstream. */
            let mut counts = rest.split_whitespace();
            g.ahead = counts
                .next()
                .and_then(|n| n.trim_start_matches('+').parse().ok())
                .unwrap_or(0);
            g.behind = counts
                .next()
                .and_then(|n| n.trim_start_matches('-').parse().ok())
                .unwrap_or(0);
        } else if let Some(rest) = line.strip_prefix("u ") {
            /* `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>` — nine
               fields and then the path, which is the whole of the remainder
               and so keeps its spaces. A conflicted file is also a dirty one. */
            g.dirty = true;
            g.conflicts += 1;
            if g.conflict_paths.len() < MAX_CONFLICT_PATHS {
                if let Some(path) = rest.splitn(10, ' ').nth(9) {
                    g.conflict_paths.push(path.to_string());
                }
            }
        } else if !line.starts_with('#') && !line.trim().is_empty() {
            g.dirty = true;
        }
    }

    g
}

/// What operation the repo is in the middle of, if any.
///
/// Nothing in `status --porcelain` says, and it matters more than anything else
/// here: **`ours` and `theirs` mean opposite things in a rebase**, where git
/// replays your commits onto the other branch and so calls the *other* branch
/// "ours". An agent told to resolve a conflict without being told which it is
/// in will confidently take the wrong side, so this is asked for and passed
/// through to the prompt.
///
/// The order of the checks is git's own (`wt-status.c`): a rebase that stops on
/// a conflict can have `MERGE_HEAD` present too, so testing for a merge first
/// would call every conflicted rebase a merge.
pub(crate) fn git_operation(root: &str) -> Option<String> {
    /* `--git-dir` rather than joining `.git` by hand: in a worktree that is a
       *file* pointing elsewhere, and worktrees are how half the cards on this
       wall are opened. */
    let dir = output(Command::new("git").current_dir(root).args([
        "--no-optional-locks",
        "rev-parse",
        "--git-dir",
    ]))?;
    let dir = Path::new(root).join(dir.trim());

    for (marker, name) in [
        ("rebase-merge", "rebase"),
        ("rebase-apply", "rebase"),
        ("CHERRY_PICK_HEAD", "cherry-pick"),
        ("REVERT_HEAD", "revert"),
        ("MERGE_HEAD", "merge"),
    ] {
        if dir.join(marker).exists() {
            return Some(name.to_string());
        }
    }
    None
}

/* ── fetching ──────────────────────────────────────────────────────────────
 *
 * The one thing on this file's slow path that leaves the machine. Everything
 * else here reads the disk; a fetch talks to a remote, so it gets its own
 * command, its own cadence (decided in `actions.svelte.ts`) and no verdict at
 * all — it is fire-and-forget, and what it changes is read by the status poll
 * that is already running. */

/// Roots with a fetch in flight, so a slow remote can never stack up a thread
/// per tick. A `Vec` rather than a set because this is at most one entry per
/// territory on the wall.
static FETCHING: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Holds a root's place in `FETCHING` for as long as its fetch is running.
struct InFlight(String);

impl InFlight {
    /// `None` when this root is already being fetched.
    fn claim(root: &str) -> Option<Self> {
        let mut live = FETCHING.lock().ok()?;
        if live.iter().any(|r| r == root) {
            return None;
        }
        live.push(root.to_string());
        Some(InFlight(root.to_string()))
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        if let Ok(mut live) = FETCHING.lock() {
            live.retain(|r| r != &self.0);
        }
    }
}

/// `git fetch` for one repo, with every way it could stop and wait shut off.
///
/// A background fetch must never ask a question. Without these, a repo whose
/// credentials have expired pops Git Credential Manager's *window* — over the
/// wall, from a poll nobody asked for — or, worse, blocks forever on a prompt
/// there is no terminal to answer. `GIT_TERMINAL_PROMPT=0` and
/// `credential.interactive=false` turn both into a fast failure, which is the
/// right outcome: being unable to fetch is not something to interrupt anybody
/// about, and the next tick will try again.
fn fetch_one(root: &str) -> bool {
    let mut cmd = Command::new("git");
    cmd.current_dir(root)
        .args([
            "--no-optional-locks",
            "-c",
            "credential.interactive=false",
            "fetch",
            "--quiet",
        ])
        .env("GIT_TERMINAL_PROMPT", "0");
    quiet(&mut cmd)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Bring these repos' remote-tracking refs up to date, in the background.
///
/// Returns immediately with the roots it actually started on — a fetch takes as
/// long as the network takes, and nothing in the UI is waiting for it. The new
/// `behind` count turns up on the next `poll_projects`, which is at most eight
/// seconds later, and that is what makes a pull chip appear.
#[tauri::command]
pub fn fetch_projects(roots: Vec<String>) -> Vec<String> {
    let mut started = Vec::new();
    for root in roots {
        let Some(guard) = InFlight::claim(&root) else {
            continue;
        };
        started.push(root.clone());
        /* One thread each, so a repo on a dead VPN delays nobody else. The
           guard moves in with it and is released when it ends, however it
           ends. */
        std::thread::spawn(move || {
            let _held = guard;
            fetch_one(&root);
        });
    }
    started
}

/* ── is this project's editor open? ───────────────────────────────────────── */

/// Every top-level Unreal window on the desktop, as (pid, title).
#[cfg(windows)]
fn unreal_windows() -> Vec<(u32, String)> {
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM, TRUE};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
    };

    unsafe extern "system" fn visit(hwnd: HWND, lparam: LPARAM) -> BOOL {
        unsafe {
            let found = &mut *(lparam.0 as *mut Vec<(u32, String)>);
            if !IsWindowVisible(hwnd).as_bool() {
                return TRUE;
            }
            /* The class is the guard. A browser tab called "… Unreal Editor"
               would otherwise read as a running editor, and the whole point of
               this is deciding whether to send a compile somewhere. */
            let mut class = [0u16; 64];
            let n = GetClassNameW(hwnd, &mut class);
            if n <= 0 || !String::from_utf16_lossy(&class[..n as usize]).starts_with("Unreal") {
                return TRUE;
            }
            let mut text = [0u16; 512];
            let n = GetWindowTextW(hwnd, &mut text);
            if n <= 0 {
                return TRUE;
            }
            let title = String::from_utf16_lossy(&text[..n as usize]);
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid != 0 {
                found.push((pid, title));
            }
            TRUE
        }
    }

    let mut found: Vec<(u32, String)> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(visit), LPARAM(&mut found as *mut _ as isize));
    }
    found
}

#[cfg(not(windows))]
fn unreal_windows() -> Vec<(u32, String)> {
    Vec::new()
}

/// Every running `UnrealEditor.exe`, as (pid, command line).
///
/// The authoritative answer, and the expensive one — a PowerShell spawn, so it
/// is cached hard and only ever reached for when the window pass came back with
/// nothing. Deliberately quote-free: quotes get mangled between an argv and
/// powershell's own re-parse of `-Command`, which is a debugging afternoon
/// nobody needs twice.
fn unreal_processes() -> Vec<(u32, String)> {
    static CACHE: Mutex<Option<(Instant, Vec<(u32, String)>)>> = Mutex::new(None);
    const TTL: Duration = Duration::from_secs(15);

    if let Ok(cache) = CACHE.lock() {
        if let Some((at, hits)) = cache.as_ref() {
            if at.elapsed() < TTL {
                return hits.clone();
            }
        }
    }

    let out = output(Command::new("powershell").args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | Where-Object Name -eq UnrealEditor.exe \
         | ForEach-Object { ($_.ProcessId, $_.CommandLine) -join [char]9 }",
    ]))
    .unwrap_or_default();

    let hits: Vec<(u32, String)> = out
        .lines()
        .filter_map(|l| {
            let (pid, cmd) = l.split_once('\t')?;
            Some((pid.trim().parse().ok()?, cmd.to_string()))
        })
        .collect();

    if let Ok(mut cache) = CACHE.lock() {
        *cache = Some((Instant::now(), hits.clone()));
    }
    hits
}

/// Which window, if any, belongs to *this* project's editor.
fn window_pid(name: &str, windows: &[(u32, String)]) -> Option<u32> {
    let needle = name.to_lowercase();
    windows
        .iter()
        .find(|(_, title)| {
            let t = title.to_lowercase();
            t.contains(&needle) && t.contains("unreal")
        })
        .map(|(pid, _)| *pid)
}

/// Which process, if any, was told to open this project's `.uproject`.
fn process_pid(name: &str, procs: &[(u32, String)]) -> Option<u32> {
    let uproject = format!("{}.uproject", name.to_lowercase());
    procs
        .iter()
        .find(|(_, cmd)| cmd.to_lowercase().contains(&uproject))
        .map(|(pid, _)| *pid)
}

#[tauri::command]
pub async fn poll_projects(requests: Vec<PollRequest>) -> Vec<ProjectStatus> {
    /* One window sweep for the whole wall, not one per project. */
    let unreal = requests.iter().any(|r| r.unreal_name.is_some());
    let windows = if unreal { unreal_windows() } else { Vec::new() };

    let mut by_window: Vec<(String, Option<u32>)> = Vec::new();
    for r in &requests {
        by_window.push((
            r.root.clone(),
            r.unreal_name.as_deref().and_then(|n| window_pid(n, &windows)),
        ));
    }

    /* The expensive answer, and only when the cheap one came back empty for
       some Unreal project: an editor still loading has no window yet, and one
       minimised to the tray has none either. */
    let procs = if requests
        .iter()
        .zip(&by_window)
        .any(|(r, (_, pid))| r.unreal_name.is_some() && pid.is_none())
    {
        unreal_processes()
    } else {
        Vec::new()
    };

    requests
        .into_iter()
        .zip(by_window)
        .map(|(r, (_, from_window))| {
            let g = if r.git { git_status(&r.root) } else { Git::default() };
            ProjectStatus {
                editor_pid: from_window.or_else(|| {
                    r.unreal_name
                        .as_deref()
                        .and_then(|n| process_pid(n, &procs))
                }),
                branch: g.branch,
                upstream: g.upstream,
                ahead: g.ahead,
                behind: g.behind,
                dirty: g.dirty,
                conflicts: g.conflicts,
                conflict_paths: g.conflict_paths,
                operation: g.operation,
                root: r.root,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reg_query_value_is_read_off_the_reg_sz_line() {
        let out = "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\EpicGames\\Unreal Engine\\5.8\r\n    \
                   InstalledDirectory    REG_SZ    C:\\Program Files\\Epic Games\\UE_5.8\r\n\r\n";
        assert_eq!(
            parse_reg_sz(out).as_deref(),
            Some("C:\\Program Files\\Epic Games\\UE_5.8")
        );
    }

    #[test]
    fn a_registry_miss_is_not_a_path() {
        assert_eq!(parse_reg_sz("ERROR: The system was unable to find..."), None);
        assert_eq!(parse_reg_sz(""), None);
    }

    /// Both distances come off one header, and the pull chip is the second of
    /// them — which was parsed and thrown away for as long as only push existed.
    #[test]
    fn both_distances_are_read_off_branch_ab() {
        let g = parse_status(
            "# branch.oid abc123\n\
             # branch.head main\n\
             # branch.upstream origin/main\n\
             # branch.ab +2 -5\n",
        );
        assert_eq!(g.branch.as_deref(), Some("main"));
        assert!(g.upstream);
        assert_eq!(g.ahead, 2);
        assert_eq!(g.behind, 5);
        assert!(!g.dirty);
    }

    /// No upstream means no `branch.ab` at all, so there is nothing to count
    /// against — and neither distance may be invented from the absence.
    #[test]
    fn an_untracked_branch_is_neither_ahead_nor_behind() {
        let g = parse_status("# branch.head spike\n1 .M N... 100644 100644 100644 a b file.rs\n");
        assert_eq!(g.branch.as_deref(), Some("spike"));
        assert!(!g.upstream);
        assert_eq!(g.ahead, 0);
        assert_eq!(g.behind, 0);
        assert!(g.dirty);
    }

    /// `(detached)` is what git calls a HEAD that is not on a branch, and it
    /// must not turn up on a chip as though it were one.
    #[test]
    fn a_detached_head_is_not_a_branch() {
        let g = parse_status("# branch.head (detached)\n");
        assert_eq!(g.branch, None);
    }

    /// `u` lines are conflicts, and their path is everything after the nine
    /// fields — so a path with a space in it stays one path.
    #[test]
    fn unmerged_entries_are_counted_and_named() {
        let g = parse_status(
            "# branch.head main\n\
             1 .M N... 100644 100644 100644 aaa bbb src/clean.rs\n\
             u UU N... 100644 100644 100644 100644 h1 h2 h3 src/both.rs\n\
             u UU N... 100644 100644 100644 100644 h1 h2 h3 docs/a note.md\n",
        );
        assert_eq!(g.conflicts, 2);
        assert_eq!(g.conflict_paths, vec!["src/both.rs", "docs/a note.md"]);
        /* A conflicted tree is a dirty one, whatever else is in it. */
        assert!(g.dirty);
    }

    /// Thousands of paths is a real outcome of merging a generated tree, and
    /// none of them are drawn — only the count is.
    #[test]
    fn the_path_list_is_capped_but_the_count_is_not() {
        let line = "u UU N... 100644 100644 100644 100644 h1 h2 h3 f";
        let out: String = (0..40).map(|i| format!("{line}{i}\n")).collect();
        let g = parse_status(&out);
        assert_eq!(g.conflicts, 40);
        assert_eq!(g.conflict_paths.len(), MAX_CONFLICT_PATHS);
    }

    /// pnpm unless the repo says otherwise — npm is what gets typed by habit.
    #[test]
    fn the_default_manager_is_pnpm() {
        let dir = std::env::temp_dir().join("skein-probe-default");
        let _ = std::fs::create_dir_all(&dir);
        assert_eq!(manager_for(&dir, None), "pnpm");
    }

    #[test]
    fn a_declared_manager_beats_a_lockfile() {
        let dir = std::env::temp_dir().join("skein-probe-declared");
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join("package-lock.json"), "{}");
        let pkg = serde_json::json!({ "packageManager": "pnpm@9.1.0" });
        assert_eq!(manager_for(&dir, Some(&pkg)), "pnpm");
        /* …and something that is not one of the four is not a declaration. */
        let odd = serde_json::json!({ "packageManager": "corepack@1" });
        assert_eq!(manager_for(&dir, Some(&odd)), "npm");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_lockfile_is_evidence_somebody_ran_that_manager_here() {
        let dir = std::env::temp_dir().join("skein-probe-lock");
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join("bun.lock"), "");
        assert_eq!(manager_for(&dir, None), "bun");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /* ── versions ──────────────────────────────────────────────────────────
     *
     * Every fixture here is the real shape of the file it stands for, taken
     * off this repository at 0.7.0 — which is the live test case the whole
     * feature was written against. */

    const PKG: &str = "{\n  \"name\": \"volery\",\n  \"private\": true,\n  \
                       \"version\": \"0.7.0\",\n  \"type\": \"module\",\n  \
                       \"scripts\": {\n    \"dev\": \"vite\",\n    \
                       \"version\": \"never mine\"\n  }\n}\n";

    #[test]
    fn a_json_version_is_the_top_level_one() {
        assert_eq!(json_version(PKG).as_deref(), Some("0.7.0"));
        /* The one inside `scripts` is at depth 2 and is somebody else's. */
        let (was, out) = set_version("json", PKG, "0.8.0").unwrap();
        assert_eq!(was, "0.7.0");
        assert!(out.contains("\"version\": \"0.8.0\","));
        assert!(out.contains("\"version\": \"never mine\""));
    }

    /// A brace inside a string must not put the depth count out — this repo's
    /// own `test` script is one line naming fifty files, and anything with a
    /// brace in it would hide every line after it.
    #[test]
    fn braces_inside_strings_do_not_count() {
        let text = "{\n  \"scripts\": {\n    \"x\": \"echo {} }}} {\"\n  },\n  \
                    \"version\": \"1.2.3\"\n}\n";
        assert_eq!(json_version(text).as_deref(), Some("1.2.3"));
    }

    /// Tauri lets `version` be a *path* to a package.json. It is read, because
    /// what a file says is a fact; whether it is a version to bump is decided
    /// in `actions.ts`, which is where it gets rejected.
    #[test]
    fn a_tauri_version_that_is_a_path_is_still_read_verbatim() {
        let text = "{\n  \"version\": \"../package.json\"\n}\n";
        assert_eq!(json_version(text).as_deref(), Some("../package.json"));
    }

    #[test]
    fn a_toml_version_is_only_the_package_sections() {
        let text = "[package]\nname = \"skein\"\nversion = \"0.7.0\"\n\n\
                    [dependencies]\nserde = { version = \"1\" }\n\n\
                    [package.metadata.bundle]\nversion = \"nope\"\n";
        assert_eq!(toml_package_version(text).as_deref(), Some("0.7.0"));
        assert_eq!(toml_package_name(text).as_deref(), Some("skein"));
        let out = set_version("toml", text, "0.8.0").unwrap().1;
        assert!(out.contains("version = \"0.8.0\""));
        assert!(out.contains("serde = { version = \"1\" }"));
        assert!(out.contains("version = \"nope\""));
    }

    /// A version inherited from a workspace is not this file's to set, and the
    /// absence of a quoted string is how that is known.
    #[test]
    fn a_workspace_inherited_version_is_not_found() {
        let text = "[package]\nname = \"member\"\nversion.workspace = true\n";
        assert_eq!(toml_package_version(text), None);
        assert_eq!(set_version("toml", text, "0.8.0"), None);
    }

    #[test]
    fn an_unreal_project_version_is_unquoted_and_may_have_four_parts() {
        let text = "[/Script/EngineSettings.GeneralProjectSettings]\n\
                    ProjectID=ABC\nProjectVersion=1.0.0.4 ; the build number\n";
        assert_eq!(ini_project_version(text).as_deref(), Some("1.0.0.4"));
        let out = set_version("ini", text, "1.1.0.0").unwrap().1;
        assert!(out.contains("ProjectVersion=1.1.0.0 ; the build number"));
    }

    /// The lock's entry is found by crate name, not by position: a lock holds
    /// several hundred `[[package]]` blocks and every one of them has a
    /// `version` line.
    #[test]
    fn a_lock_entry_is_found_by_crate_name() {
        let text = "[[package]]\nname = \"serde\"\nversion = \"1.0.0\"\n\n\
                    [[package]]\nname = \"skein\"\nversion = \"0.7.0\"\n\
                    dependencies = [\n \"rusqlite\",\n]\n";
        let out = set_lock_version(text, "skein", "0.8.0").unwrap().1;
        assert!(out.contains("name = \"serde\"\nversion = \"1.0.0\""));
        assert!(out.contains("name = \"skein\"\nversion = \"0.8.0\""));
        assert_eq!(set_lock_version(text, "not-here", "0.8.0"), None);
    }

    /// Only the value is touched, so indentation, trailing commas, comments and
    /// CRLF endings all survive — the whole reason this is a text edit and not
    /// a re-serialize.
    #[test]
    fn a_splice_leaves_every_other_byte_alone() {
        let text = "{\r\n\t\"version\":   \"0.7.0\",   \r\n\t\"x\": 1\r\n}\r\n";
        let out = set_version("json", text, "0.8.0").unwrap().1;
        assert_eq!(out, "{\r\n\t\"version\":   \"0.8.0\",   \r\n\t\"x\": 1\r\n}\r\n");
    }

    /// A shape with nothing to edit refuses, and that refusal is what stops a
    /// bump half-writing: `actions.rs` asks every file before writing any.
    #[test]
    fn a_file_with_no_version_field_refuses() {
        assert_eq!(set_version("json", "{\n  \"name\": \"x\"\n}\n", "1.0.0"), None);
        assert_eq!(set_version("ini", "[Section]\nOther=1\n", "1.0.0"), None);
        assert_eq!(set_version("elvish", PKG, "1.0.0"), None);
    }

    #[test]
    fn an_editor_window_is_matched_by_project_and_not_by_the_word_alone() {
        let windows = vec![
            (10, "Untitled - Notepad".to_string()),
            (20, "Overworld - Caravan - Unreal Editor".to_string()),
        ];
        assert_eq!(window_pid("Caravan", &windows), Some(20));
        /* Another project's editor must never receive our compile triggers. */
        let others = vec![(30, "Lyra - Unreal Editor".to_string())];
        assert_eq!(window_pid("Caravan", &others), None);
    }

    #[test]
    fn a_loading_editor_is_found_by_what_it_was_told_to_open() {
        let procs = vec![
            (40, r"...\UnrealEditor.exe C:\atelier\lyra\Lyra.uproject".to_string()),
            (41, r"...\UnrealEditor.exe C:\atelier\caravan\Caravan.uproject -x".to_string()),
        ];
        assert_eq!(process_pid("Caravan", &procs), Some(41));
        assert_eq!(process_pid("Nothing", &procs), None);
    }
}
