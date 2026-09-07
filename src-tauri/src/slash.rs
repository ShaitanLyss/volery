//! The slash commands a project has of its own.
//!
//! The dock's palette offers three vocabularies under one slash: Volery's own
//! commands (fixed, `commands.ts`), the **skills** a card declared (folded off
//! `system/init`), and these — the markdown files in `.claude/commands/`. This
//! module is the third, and it is the only one of the three that has to go and
//! look at a disk.
//!
//! **Why a directory walk rather than the wire, when the wire carries them.**
//! `system/init`'s `slash_commands` array holds all three sets at once. Probed
//! 2026-09-07 against claude 2.1.233 with `tools/probe-skills.ts`, having seeded
//! three files into a scratch project: the 60 names came back **project
//! commands first, then the skills, then the CLI's built-ins**. So the set
//! wanted here is a prefix of that array — and taking it would mean trusting the
//! order of an undocumented list, which is the kind of dependency that breaks
//! without saying so. Subtracting instead does not work either: `slash_commands
//! − skills` still leaves ~30 built-ins, and the only way to name those is a
//! table of them, which goes stale the next time the CLI grows one.
//!
//! A walk answers exactly the question being asked, by construction, and it
//! brings something the wire has not got: a command file may carry a
//! `description:` in its frontmatter, so unlike a skill these rows can say what
//! they do in their author's own words. Cross-checked against the same probe —
//! `bare.md`, `deep/nested.md` and `hello.md` enumerate to `bare`, `deep:nested`
//! and `hello`, which is name-for-name what the CLI reported.
//!
//! **A separator, not a path.** A command in a subdirectory is named with a
//! colon (`deep/nested.md` → `deep:nested`), which is the same spelling a
//! plugin's skills use (`tx-toolkit:committee`) and is why `commands.ts`'s
//! `NAME_CHAR` admits one.
//!
//! Read on demand and cached by the front end, the way the finder's file list is
//! (`.claude/rules/finding.md`) — this is a one-shot read, not a fourth poller,
//! and it owes no argument on that score for the same reason `read_ai_title`
//! owes none.

use serde::Serialize;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

/// How deep a `commands` tree is followed.
///
/// Four is already two more than anybody nests these, and the bound is here for
/// the case a walk must never meet: a directory symlink pointing at its own
/// parent, which is not an error anywhere and would otherwise spin.
const MAX_DEPTH: usize = 4;

/// How many commands are returned at most.
///
/// A palette is read by eye, and a project that has somehow put a thousand
/// markdown files under `.claude/commands` wants a bound rather than a dock that
/// stops painting. Said out loud in `truncated` rather than silently applied —
/// a list that quietly stops is one that claims a command does not exist.
const MAX_COMMANDS: usize = 200;

/// How much of a command file is read looking for its frontmatter.
///
/// The block is at the very top by definition, so this only has to clear a
/// generous one. A command's *body* can be any size and none of it is wanted
/// here — reading whole files would make this walk proportional to the prompts
/// in them rather than to how many there are.
const FRONTMATTER_BYTES: usize = 4 * 1024;

/// One command a project or the user has written.
#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct SlashCommand {
    /// What is typed after the slash, subdirectories folded to colons.
    pub name: String,
    /// The `description:` from its frontmatter, or `None` where it has none.
    ///
    /// Optional because a command file needs no frontmatter at all — `bare.md`
    /// in the probe above is a body and nothing else, and it is a perfectly
    /// good command. The palette says where it came from instead, which is what
    /// it does for every skill.
    pub description: Option<String>,
    /// `project` for one in the working tree, `user` for one in `~/.claude`.
    pub scope: &'static str,
}

/// What a project offers under a slash, project scope before user scope.
///
/// `async`, through `crate::off_main`, because it walks directories and reads
/// files — the rule on blocking commands does not care that it is usually fast,
/// and a walk over a tree somebody has symlinked into a network share is
/// exactly the case that would freeze every card on the wall. See `off_main`.
#[tauri::command]
pub async fn project_commands(
    app: AppHandle,
    cwd: String,
) -> Result<Vec<SlashCommand>, String> {
    let home = app.path().home_dir().ok();
    crate::off_main(move || commands_in(Path::new(&cwd), home.as_deref())).await
}

/// The read itself, apart from the command that carries it, so it can be tested
/// against a real directory without a Tauri app.
///
/// Project scope first and user scope second, and the order is load-bearing
/// rather than cosmetic: a name defined in both places is the project's, which
/// is Claude Code's own precedence, and `push_unique` keeps the first of any
/// name it sees.
pub fn commands_in(cwd: &Path, home: Option<&Path>) -> Vec<SlashCommand> {
    let mut out: Vec<SlashCommand> = Vec::new();
    collect(&cwd.join(".claude").join("commands"), "project", &mut out);
    if let Some(home) = home {
        collect(&home.join(".claude").join("commands"), "user", &mut out);
    }
    out
}

/// Everything under one root, appended to `out`.
///
/// A missing root is the ordinary answer and not an error: most projects have no
/// `.claude/commands` at all, and this machine has no user-level one either.
fn collect(root: &Path, scope: &'static str, out: &mut Vec<SlashCommand>) {
    walk(root, root, 0, scope, out);
    /* Sorted per root rather than over the whole list, so project commands stay
       ahead of user ones — the palette's own ordering rule is that the more
       local vocabulary comes first, the way `COMMANDS` comes before either. */
    let from = out.len() - out.iter().rev().take_while(|c| c.scope == scope).count();
    out[from..].sort_by(|a, b| a.name.cmp(&b.name));
}

fn walk(root: &Path, at: &Path, depth: usize, scope: &'static str, out: &mut Vec<SlashCommand>) {
    if depth > MAX_DEPTH || out.len() >= MAX_COMMANDS {
        return;
    }
    let Ok(entries) = std::fs::read_dir(at) else {
        return;
    };
    /* Collected and sorted rather than taken in `read_dir` order, which is the
       filesystem's and differs between machines. A palette whose rows move when
       the same repo is opened somewhere else is one nobody can build a habit
       on. */
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut files: Vec<PathBuf> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        /* `file_type` rather than a `metadata` call, so a symlink is seen as a
           symlink: `is_dir` on the followed target is what makes a loop
           possible in the first place, and `MAX_DEPTH` is only the backstop. */
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            dirs.push(path);
        } else if kind.is_file() {
            files.push(path);
        }
    }
    dirs.sort();
    files.sort();
    for path in files {
        if out.len() >= MAX_COMMANDS {
            return;
        }
        if !path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("md"))
        {
            continue;
        }
        if let Some(name) = name_of(root, &path) {
            push_unique(
                out,
                SlashCommand {
                    name,
                    description: description_of(&path),
                    scope,
                },
            );
        }
    }
    for dir in dirs {
        walk(root, &dir, depth + 1, scope, out);
    }
}

/// The name a file is typed as: its path below the root, minus `.md`, with the
/// separators folded to colons.
///
/// `None` for anything that cannot produce one — a path that is somehow not
/// below the root, or a stem that is empty. Lowercased, since the palette
/// matches in lowercase and a `Commit.md` that could not be found by typing
/// `/commit` would be a command with a name nobody can reach.
fn name_of(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let mut parts: Vec<String> = rel
        .parent()
        .into_iter()
        .flat_map(|p| p.components())
        .map(|c| c.as_os_str().to_string_lossy().to_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    let stem = rel.file_stem()?.to_string_lossy().to_lowercase();
    if stem.is_empty() {
        return None;
    }
    parts.push(stem);
    Some(parts.join(":"))
}

/// Keep the first command of any given name.
///
/// The project's wins over the user's, which is Claude Code's own precedence and
/// the reason `commands_in` walks the two roots in that order. Two files in one
/// root cannot collide — a name is its path — so this only ever fires across
/// scopes.
fn push_unique(out: &mut Vec<SlashCommand>, cmd: SlashCommand) {
    if out.iter().any(|c| c.name == cmd.name) {
        return;
    }
    out.push(cmd);
}

/// The `description:` out of a command file's frontmatter, or `None`.
///
/// Deliberately not a YAML parser. The whole of what is wanted is one scalar
/// out of a block whose shape the CLI itself documents, and every failure here
/// has the same harmless answer — a palette row that says where the command came
/// from instead of what it does, which is exactly what a skill's row says.
fn description_of(path: &Path) -> Option<String> {
    let head = read_head(path)?;
    let mut lines = head.lines();
    /* A block or nothing: frontmatter is the first thing in the file or it is
       not frontmatter, and a `description:` in the *body* is prose about
       something else. */
    if lines.next()?.trim_end() != "---" {
        return None;
    }
    for line in lines {
        let t = line.trim_end();
        if t == "---" || t == "..." {
            return None;
        }
        let Some(rest) = t.strip_prefix("description:") else {
            continue;
        };
        let said = rest.trim().trim_matches(|c| c == '"' || c == '\'').trim();
        if said.is_empty() {
            return None;
        }
        /* Kept to one line and one screen's worth. The palette's summary column
           is a line you scan, and a description written as a paragraph would
           push every row's own name off the side. */
        let clipped: String = said.chars().take(120).collect();
        return Some(clipped);
    }
    None
}

/// The first `FRONTMATTER_BYTES` of a file, as text.
///
/// Lossy on purpose: a command file is somebody's markdown and may be in any
/// encoding at all, and a byte that is not UTF-8 is not a reason to lose the
/// command. Truncation can cut a character in half for the same reason, and the
/// replacement lands in a description rather than anywhere load-bearing.
fn read_head(path: &Path) -> Option<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).ok()?;
    let mut buf = vec![0u8; FRONTMATTER_BYTES];
    let read = file.read(&mut buf).ok()?;
    buf.truncate(read);
    Some(String::from_utf8_lossy(&buf).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A `commands` tree under a fresh temporary directory, returned as the cwd
    /// a card would be standing in.
    fn tree(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("skein-slash-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join(".claude").join("commands")).unwrap();
        root
    }

    fn write(root: &Path, rel: &str, body: &str) {
        let path = root.join(".claude").join("commands").join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    /// The shape the probe measured, name for name. `.claude/commands/bare.md`,
    /// `deep/nested.md` and `hello.md` came back off `system/init` as `bare`,
    /// `deep:nested` and `hello`, and this walk has to agree with the CLI or the
    /// palette offers names the agent will not answer to.
    #[test]
    fn a_subdirectory_becomes_a_colon_exactly_as_the_cli_names_it() {
        let root = tree("colon");
        write(&root, "hello.md", "---\ndescription: say hello\n---\nSay hello.\n");
        write(&root, "bare.md", "No frontmatter at all.\n");
        write(&root, "deep/nested.md", "---\ndescription: the nested one\n---\nGo.\n");

        let found = commands_in(&root, None);
        let names: Vec<&str> = found.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["bare", "deep:nested", "hello"]);
        assert_eq!(found[2].description.as_deref(), Some("say hello"));
        assert_eq!(found[1].description.as_deref(), Some("the nested one"));
        /* A command with no frontmatter is still a command. */
        assert_eq!(found[0].description, None);
        assert!(found.iter().all(|c| c.scope == "project"));
    }

    /// A project with nothing of its own is the ordinary case, not a failure.
    #[test]
    fn a_project_with_no_commands_directory_answers_with_none() {
        let root = std::env::temp_dir().join("skein-slash-absent-nowhere");
        assert_eq!(commands_in(&root, None), vec![]);
    }

    /// The project's own wins, which is Claude Code's precedence — and the user's
    /// other commands still come through.
    #[test]
    fn a_name_in_both_scopes_is_the_project_s() {
        let root = tree("scope");
        write(&root, "commit.md", "---\ndescription: this project's commit\n---\n");
        let home = tree("scope-home");
        write(&home, "commit.md", "---\ndescription: the user's commit\n---\n");
        write(&home, "elsewhere.md", "---\ndescription: only the user has this\n---\n");

        let found = commands_in(&root, Some(&home));
        assert_eq!(
            found.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
            vec!["commit", "elsewhere"]
        );
        assert_eq!(found[0].scope, "project");
        assert_eq!(found[0].description.as_deref(), Some("this project's commit"));
        assert_eq!(found[1].scope, "user");
    }

    /// Only markdown, and the name is reachable by typing it.
    #[test]
    fn anything_that_is_not_markdown_is_not_a_command() {
        let root = tree("kinds");
        write(&root, "README.txt", "not a command");
        write(&root, "notes", "not a command either");
        write(&root, "Commit.MD", "---\ndescription: mixed case\n---\n");

        let found = commands_in(&root, None);
        /* Lowercased, or a `Commit.md` could not be found by typing `/commit`
           — the palette matches in lowercase. */
        assert_eq!(
            found.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
            vec!["commit"]
        );
    }

    /// A `description:` in the body is prose about something else.
    #[test]
    fn a_description_outside_the_frontmatter_block_is_not_one() {
        let root = tree("body");
        write(&root, "a.md", "Some prose.\ndescription: not frontmatter\n");
        write(&root, "b.md", "---\ntitle: no description here\n---\ndescription: still not\n");
        write(&root, "c.md", "---\ndescription: \"quoted, and taken\"\n---\n");

        let found = commands_in(&root, None);
        assert_eq!(found[0].description, None, "a body is not a frontmatter block");
        assert_eq!(found[1].description, None, "past the closing --- is the body");
        assert_eq!(found[2].description.as_deref(), Some("quoted, and taken"));
    }

    /// The walk stops rather than following a tree down forever. Depth is
    /// asserted with plain directories, since a symlink needs a privilege on
    /// Windows that a test cannot count on having.
    #[test]
    fn the_walk_is_bounded_by_depth() {
        let root = tree("depth");
        write(&root, "a/b/c/d/deep.md", "---\ndescription: within\n---\n");
        write(&root, "a/b/c/d/e/f/too-deep.md", "---\ndescription: beyond\n---\n");

        let names: Vec<String> = commands_in(&root, None).into_iter().map(|c| c.name).collect();
        assert!(names.contains(&"a:b:c:d:deep".to_string()), "{names:?}");
        assert!(
            !names.iter().any(|n| n.ends_with("too-deep")),
            "past MAX_DEPTH is not walked: {names:?}"
        );
    }

    /// Order does not come from the filesystem, so the palette's rows do not
    /// move when the same repo is opened on another machine.
    #[test]
    fn the_rows_are_sorted_within_each_scope() {
        let root = tree("order");
        for name in ["zebra.md", "alpha.md", "middle.md"] {
            write(&root, name, "body\n");
        }
        assert_eq!(
            commands_in(&root, None)
                .iter()
                .map(|c| c.name.as_str())
                .collect::<Vec<_>>(),
            vec!["alpha", "middle", "zebra"]
        );
    }
}
