//! The plugin Volery hands every project card: the coordinator's method and
//! the two reviewers it runs work past.
//!
//! **Why a plugin, and why `--plugin-dir`.** Coordination (one card ruling on a
//! queue, opening worker cards, owning the gate) is a method most cards never
//! use, so it must not be prose in `--append-system-prompt`, which every card
//! pays for in full on every request. A skill costs its one-line description
//! per request and its body only when it is invoked; an agent costs its
//! description in the `Agent` tool's schema. Probed against claude 2.1.318 on
//! 2026-11-06 (`tools/probe-kit.ts`):
//!
//! - `--plugin-dir <dir>` loads a plugin for that session only. `initialize`
//!   lists `volery:coordinate` with its description, `system/init.skills` has
//!   it, `system/init.agents` has `volery:red-team` and `volery:verifier`
//!   beside the built-ins, the user's plugins and `--agents`' `scout` (it
//!   merges; nothing was displaced), and `plugins` reports it as
//!   `volery@inline` at this path.
//! - `/volery:coordinate` in a prompt loads the body: a canary in it came back.
//! - Nothing under `~/.claude` was written. `installed_plugins.json` and
//!   `settings.json` kept their mtimes.
//! - Per request it costs **356 input tokens**: 61,126 without it and 61,482
//!   with it on the same Haiku turn, three runs alike (the first run of all
//!   read 61,922 once and never again). Nearly all of it is a cache read.
//!
//! The same bargain `supervisor::agents` and `guidance::compose` strike: this
//! app does not write to the user's config, so what every card should have
//! arrives at spawn. The files are compiled in and laid out under the app data
//! folder, which is Volery's own (a lab wall has its own, so a lab's kit never
//! reaches the installed wall's cards). They are rewritten only when a byte
//! differs, and anything under the folder this build does not ship is removed,
//! so a skill dropped from a later build is not still offered by an old file.
//!
//! **Chat cards get none of it**, for `supervisor::agents`' reason: they have
//! no `Agent` tool and no file tools, so every part of it names something they
//! cannot do.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

/// Every file in the kit, by its path under the plugin's root. The source of
/// truth is `src-tauri/kit/volery/`; this table is the whole of what ships, and
/// `prune` removes anything else it finds.
const FILES: &[(&str, &str)] = &[
    (".claude-plugin/plugin.json", include_str!("../kit/volery/.claude-plugin/plugin.json")),
    ("skills/coordinate/SKILL.md", include_str!("../kit/volery/skills/coordinate/SKILL.md")),
    (
        "skills/coordinate/brief-common.template.md",
        include_str!("../kit/volery/skills/coordinate/brief-common.template.md"),
    ),
    /* Node rather than shell: a card may have PowerShell and no Bash, `sh` is
       not on PATH from PowerShell on this machine, and Windows PowerShell 5.1
       writes a redirected patch as UTF-16, which `git apply` cannot read. Node
       is what the scripts already needed, and each writes its own files. */
    (
        "skills/coordinate/scripts/commit-split.mjs",
        include_str!("../kit/volery/skills/coordinate/scripts/commit-split.mjs"),
    ),
    (
        "skills/coordinate/scripts/check-imports.mjs",
        include_str!("../kit/volery/skills/coordinate/scripts/check-imports.mjs"),
    ),
    (
        "skills/coordinate/scripts/gate.mjs",
        include_str!("../kit/volery/skills/coordinate/scripts/gate.mjs"),
    ),
    ("agents/red-team.md", include_str!("../kit/volery/agents/red-team.md")),
    ("agents/verifier.md", include_str!("../kit/volery/agents/verifier.md")),
];

/// The skill a card is pointed at when it starts coordinating, as the CLI
/// names it: the plugin's name, a colon, the skill's folder.
pub const COORDINATE: &str = "volery:coordinate";

/// Where the kit is, or `None` if there is none to hand the card — in which
/// case it spawns without it, a card missing a method rather than one that
/// fails to start.
///
/// Laid once per process, on the first spawn that asks, and again if the
/// manifest has gone from disk since (somebody cleared the folder): a path to a
/// plugin that is not there is a flag nobody has probed the CLI's answer to.
/// A lay that fails part-way still hands over what an earlier launch left, as
/// long as its manifest is there: an older copy of a skill beats none, and the
/// failure is logged. A failure is not remembered, so the next spawn tries again.
pub fn dir(app: &AppHandle) -> Option<PathBuf> {
    static LAID: AtomicBool = AtomicBool::new(false);
    /* Two cards spawned in the same moment would otherwise lay it together,
       and one's `prune` can take the other's temporary file out from under
       its rename. */
    static LAYING: Mutex<()> = Mutex::new(());
    let root = app.path().app_data_dir().ok()?.join("kit").join("volery");
    let whole = |root: &Path| root.join(MANIFEST).is_file();
    if LAID.load(Ordering::Acquire) && whole(&root) {
        return Some(root);
    }
    let _laying = LAYING.lock().unwrap_or_else(|e| e.into_inner());
    if LAID.load(Ordering::Acquire) && whole(&root) {
        return Some(root);
    }
    match lay(&root) {
        Ok(()) => {
            LAID.store(true, Ordering::Release);
            Some(root)
        }
        Err(e) => {
            log::warn!("kit: could not lay out the card kit at {}: {e}", root.display());
            whole(&root).then_some(root)
        }
    }
}

/// The file the CLI recognises a plugin by.
const MANIFEST: &str = ".claude-plugin/plugin.json";

/// Write every file whose bytes differ, then remove what this build does not
/// ship. Each write goes through a sibling temporary file and a rename, so a
/// card reading the kit while another Volery lays it never reads half a file.
fn lay(root: &Path) -> Result<(), String> {
    for (rel, body) in FILES {
        let path = root.join(rel);
        if std::fs::read(&path).ok().as_deref() == Some(body.as_bytes()) {
            continue;
        }
        let parent = path.parent().ok_or_else(|| format!("{rel} has no parent"))?;
        std::fs::create_dir_all(parent).map_err(|e| format!("make {}: {e}", parent.display()))?;
        let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
        std::fs::write(&tmp, body).map_err(|e| format!("write {}: {e}", tmp.display()))?;
        std::fs::rename(&tmp, &path).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            format!("place {}: {e}", path.display())
        })?;
    }
    prune(root, root);
    Ok(())
}

/// Remove files and empty folders under `root` that are not in [`FILES`].
/// Best effort: a stray file costs a stale listing, never a failed spawn.
/// A link is removed as a link and never followed, though nothing but this
/// module writes here.
fn prune(root: &Path, dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = std::fs::symlink_metadata(&path) else { continue };
        if meta.is_dir() && !meta.file_type().is_symlink() {
            prune(root, &path);
            let _ = std::fs::remove_dir(&path); // only succeeds when empty
            continue;
        }
        if !shipped(root, &path) {
            let _ = std::fs::remove_file(&path).or_else(|_| std::fs::remove_dir(&path));
        }
    }
}

fn shipped(root: &Path, path: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(root) else { return true };
    let rel = rel.to_string_lossy().replace('\\', "/");
    FILES.iter().any(|(f, _)| *f == rel)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("volery-kit-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    /// The CLI finds a plugin by `.claude-plugin/plugin.json` and names its
    /// skills and agents after the `name` in it. A rename here renames
    /// `volery:coordinate` under every card, the spawn receipt's pointer and
    /// the skill's own references to its agents.
    #[test]
    fn the_manifest_names_the_plugin_the_receipt_points_at() {
        let manifest: serde_json::Value =
            serde_json::from_str(FILES[0].1).expect("plugin.json parses");
        let name = manifest["name"].as_str().expect("the plugin has a name");
        assert_eq!(format!("{name}:coordinate"), COORDINATE);
        assert!(FILES.iter().any(|(f, _)| *f == "skills/coordinate/SKILL.md"));
    }

    /// A skill's description is in front of every project card on every
    /// request, and so is each agent's. Measured at 356 tokens for all three;
    /// this catches a description growing by a paragraph without anybody
    /// deciding it should.
    #[test]
    fn what_every_request_pays_for_stays_small() {
        let described: usize = FILES
            .iter()
            .filter(|(f, _)| f.ends_with("SKILL.md") || f.starts_with("agents/"))
            .map(|(f, body)| {
                let d = body
                    .lines()
                    .find_map(|l| l.strip_prefix("description:"))
                    .unwrap_or_else(|| panic!("{f} has no description"));
                d.trim().len()
            })
            .sum();
        assert!(
            described < 1_200,
            "the kit's descriptions are {described} bytes on every request of every card"
        );
    }

    /// Lay it twice into an empty folder with a stray file planted: every file
    /// arrives with its bytes, the stray goes, and the second lay changes
    /// nothing.
    #[test]
    fn laying_out_writes_what_ships_and_nothing_else() {
        let root = scratch("lay");
        std::fs::create_dir_all(root.join("skills/old")).unwrap();
        std::fs::write(root.join("skills/old/SKILL.md"), "a skill a later build dropped").unwrap();
        lay(&root).expect("lays");
        for (rel, body) in FILES {
            assert_eq!(std::fs::read_to_string(root.join(rel)).unwrap(), *body, "{rel}");
        }
        assert!(!root.join("skills/old").exists(), "the dropped skill is gone");
        lay(&root).expect("lays again");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// What ships is the bytes in the repository as checked out, and this
    /// machine's git checks text out with CRLF. `.gitattributes` pins the kit
    /// to LF so every build ships the same bytes whatever machine made it;
    /// this is the half that notices if a checkout or an editor puts the CR
    /// back.
    #[test]
    fn the_kit_ships_with_lf_endings() {
        for (rel, body) in FILES {
            assert!(!body.contains('\r'), "{rel} carries a CR");
        }
    }

    /// A file put in the kit's folder and referenced from the skill, but left
    /// out of `FILES`, would not ship, and `prune` would delete any copy at
    /// the user's end. So the folder and the table must agree exactly.
    #[test]
    fn every_file_in_the_kit_folder_ships() {
        fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) {
            for e in std::fs::read_dir(dir).expect("the kit folder is readable").flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(root, &p, out);
                } else {
                    let rel = p.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
                    out.push(rel);
                }
            }
        }
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("kit").join("volery");
        let mut on_disk = Vec::new();
        walk(&root, &root, &mut on_disk);
        on_disk.sort();
        let mut shipped: Vec<String> = FILES.iter().map(|(f, _)| f.to_string()).collect();
        shipped.sort();
        assert_eq!(on_disk, shipped, "src-tauri/kit/volery and kit::FILES disagree");
    }
}
