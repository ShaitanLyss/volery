//! Making the worktree a card lives in, rather than asking the CLI to.
//!
//! `claude --worktree <name>` does the whole job in one flag, and Skein used it
//! for exactly that reason. What it does with the name is the problem: probed
//! against claude 2.1.241, `--worktree feat/async-auth` makes the folder
//! `.claude/worktrees/feat+async-auth` and the branch
//! **`worktree-feat+async-auth`** — the slug *and* a prefix. The folder is fine;
//! nobody reads a path. The branch is the name that goes on a pull request, and
//! it arrives mangled at the one place a name is read by people. It was renamed
//! by hand twice on this machine before anybody worked out where it came from,
//! and the reflog is where the evidence finally was:
//!
//! ```text
//! Branch: renamed refs/heads/worktree-feat+async-auth to refs/heads/feat/async-access-control
//! ```
//!
//! There is no flag for it — `-w, --worktree [name]` is the whole surface the
//! CLI offers — so the only way to get the branch you typed is to stop
//! delegating and make the tree here. Which is three git commands, and buys two
//! things beyond the name: the base is ours to choose (the CLI always branches
//! `origin/main`, and now that is a default rather than a fact of life), and
//! `ensure` is idempotent, so waking a dormant card finds its tree instead of
//! trying to make a second one.
//!
//! The folder keeps the CLI's shape on purpose. Every worktree card that
//! existed before this module has its tree at `.claude/worktrees/<slug>`
//! already, and `ensure` finding it is the whole of what makes those cards come
//! back into the tree they have been working in rather than a fresh one beside
//! it.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/* ── no console windows ────────────────────────────────────────────────────
 *
 * A GUI app spawning a console program flashes a black window unless it says
 * not to. Same as `project.rs`, and for the same reason. */
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

/// git, with every way it could stop and ask something shut off.
///
/// `spawn_now` runs on the blocking pool, so a slow git here costs the card
/// being opened and nothing else — but a git that puts up Git Credential
/// Manager's window blocks on a prompt there is no terminal to answer, and that
/// costs the card forever. Same shape as `actions::git`.
fn git(dir: &str) -> Command {
    let mut cmd = Command::new("git");
    cmd.current_dir(dir)
        .args(["--no-optional-locks", "-c", "credential.interactive=false"])
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null());
    quiet(&mut cmd);
    cmd
}

/// `(ok, stdout, stderr)`, all trimmed.
pub(crate) fn run(dir: &str, args: &[&str]) -> (bool, String, String) {
    match git(dir).args(args).output() {
        Ok(out) => (
            out.status.success(),
            String::from_utf8_lossy(&out.stdout).trim().to_string(),
            String::from_utf8_lossy(&out.stderr).trim().to_string(),
        ),
        Err(e) => (false, String::new(), e.to_string()),
    }
}

/// The folder a branch's tree lives in, under `.claude/worktrees/`.
///
/// `/` becomes `+` because that is what the CLI does, and matching it is not
/// cosmetic: every worktree card made before this module has its tree at the
/// CLI's spelling, and `ensure` has to *find* those rather than make a second
/// tree beside each one. Anything else that cannot be in a path becomes `-`,
/// which the CLI's own behaviour past `/` is unprobed on — this is a folder
/// name, so the bar is only that it is stable and legible.
///
/// Not a general slug: `.` and `_` and `-` survive, because `feat/v2.1_fix`
/// reads better kept than folded.
pub fn slug(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for ch in name.chars() {
        match ch {
            '/' | '\\' => out.push('+'),
            c if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '+') => out.push(c),
            _ => out.push('-'),
        }
    }
    /* A folder cannot be empty, and `..` is a folder that means something else
       entirely. Neither is reachable from a branch name git would accept, but
       this builds a path out of a string a person typed and the cost of being
       sure is one line. */
    if out.is_empty() || out.chars().all(|c| c == '.') {
        return "worktree".into();
    }
    out
}

/// Where a branch's tree goes.
pub fn dir_for(root: &str, name: &str) -> PathBuf {
    Path::new(root).join(".claude").join("worktrees").join(slug(name))
}

/// **Where a card's child actually runs** — its territory, or the tree for its
/// branch when it has one.
///
/// This is the answer `ensure` gives, without the making of it, and it is what
/// anything that is not spawning a process should ask. The distinction is the
/// whole reason it exists separately: reading a card's transcript, or resolving
/// a relative path an agent wrote, wants the directory and must not create a git
/// worktree as a side effect of a look.
///
/// **Every question the CLI answers per-directory is a question about *this*
/// directory**, and a year of the app asking it about `cwd` instead is the bug
/// this was extracted for. The row's `cwd` is the project root by design (see
/// the module note, and `worktree.md`) — that is the card's territory, its dev
/// servers and its shell. It is not where the agent stands. Ask `cwd` about a
/// worktree card's transcript and you are told it has none, because the CLI
/// files that session under the *running* directory's slug; ask it where to
/// spawn and the agent comes back in the main tree with its history left behind
/// in the other one. Measured 2026-08-25 across the four worktree cards then on
/// the wall: every one of them had two transcripts under one session id, split
/// at the first wake, and nine respawns in the wrong tree between them.
///
/// Pure, and deliberately so — no git, nothing made, nothing on disk consulted.
/// `ensure` must return this same path for the same pair, which is what makes
/// the transcript a running card writes the one a dormant card reads.
pub fn run_dir(cwd: &str, worktree: Option<&str>) -> String {
    match worktree.map(str::trim).filter(|n| !n.is_empty()) {
        Some(name) => dir_for(cwd, name).to_string_lossy().into_owned(),
        None => cwd.to_string(),
    }
}

/// What to branch from, best first.
///
/// `origin/main` by default, which is what was asked for and what the CLI did
/// anyway — a worktree is nearly always started to do a piece of work that will
/// be proposed back, and branching whatever happened to be checked out means
/// carrying someone's half-finished afternoon into it.
///
/// The fallbacks are for repositories where that ref is not the answer rather
/// than for exotic ones: a repo whose default branch is `master`, a fork whose
/// remote is not called `origin`, a repo with no remote at all. `HEAD` last,
/// because a tree that gets made off the wrong base is recoverable and a card
/// that refuses to open is not.
///
/// Order matters over `origin/HEAD`: that ref is a *local guess* written when
/// the repo was cloned and never updated, so a repo whose default branch has
/// moved since still has it pointing at the old one. Asking for `origin/main`
/// first means the common case never consults it.
pub fn base_ref(root: &str) -> String {
    for candidate in ["origin/main", "origin/master"] {
        if run(root, &["rev-parse", "--verify", "--quiet", candidate]).0 {
            return candidate.into();
        }
    }
    /* `origin/HEAD` names the default branch as a symbolic ref; resolve it to
       the branch rather than using it directly, so the error message and the
       reflog both say what was actually branched. */
    let (ok, head, _) = run(root, &["symbolic-ref", "--short", "--quiet", "refs/remotes/origin/HEAD"]);
    if ok && !head.is_empty() {
        return head;
    }
    "HEAD".into()
}

/* ── worktree groups ───────────────────────────────────────────────────────
 *
 * `spawn` takes a `worktree` key, and every card given the same key shares one
 * tree (sink 93ecd434, Lyss 2026-10-16). A group is nothing but a branch name
 * in a reserved namespace: the key `auth` is the branch `wt/auth`, the folder
 * `.claude/worktrees/wt+auth`, and the row's existing `worktree` column holds
 * the branch — so every reader that already resolves a worktree card
 * (`run_dir`, `store::session_of`, the transcript reads, a wake) resolves a
 * group card with no change, and two cards with one key land in one folder
 * because `ensure` finds the second one already made.
 *
 * The namespace is what lets the wall treat a group differently from a branch
 * a person typed: only a `wt/` tree is ever taken down by the wall
 * (`retire`), because only those are trees the wall decided to make. */

/// The branch namespace a worktree group lives in.
pub const GROUP_PREFIX: &str = "wt/";

/// The longest key a group may have. A folder name and half a branch name; long
/// enough to say what the group is for, short enough to sit on a card.
pub const MAX_KEY: usize = 40;

/// A key as `spawn` was given it, made into the one spelling it is stored and
/// compared in — or the reason it cannot be one.
///
/// Lowercase, because two agents writing `Auth` and `auth` mean one group and
/// the folder would be one folder on Windows anyway — a case-only difference
/// would be two branches in one directory, which git refuses half-way through.
/// Letters, digits, `-`, `_` and `.` only: it becomes a branch component and a
/// folder name, and refusing what either cannot hold is cheaper than folding it
/// into something the caller did not write and will not recognise in a
/// receipt. No `/`, so a group is exactly one level under `wt/`.
pub fn group_key(raw: &str) -> Result<String, String> {
    let key = raw.trim().to_ascii_lowercase();
    if key.is_empty() {
        return Err("the worktree key was empty — leave `worktree` out to work in the \
                    shared tree, or give the group a short name such as `auth`"
            .into());
    }
    if key.len() > MAX_KEY {
        return Err(format!(
            "the worktree key {raw:?} is longer than {MAX_KEY} characters — it becomes a \
             branch name and a folder, so give the group a short name"
        ));
    }
    let ok_char = |c: char| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.');
    if !key.chars().all(ok_char)
        || key.starts_with(['.', '-'])
        || key.ends_with('.')
        || key.contains("..")
        || key.ends_with(".lock")
    {
        return Err(format!(
            "the worktree key {raw:?} cannot be a branch name — use letters, digits, `-`, \
             `_` and `.` only (no `/`, no spaces), for example `auth` or `ui-pass`"
        ));
    }
    Ok(key)
}

/// The branch a group's cards share.
pub fn group_branch(key: &str) -> String {
    format!("{GROUP_PREFIX}{key}")
}

/// The group a card's worktree name belongs to, if it is one.
pub fn group_of(worktree: &str) -> Option<&str> {
    worktree.trim().strip_prefix(GROUP_PREFIX).filter(|k| !k.is_empty())
}

/// One lock for every tree this process makes.
///
/// Two cards spawned into one group a moment apart reach `ensure` on two
/// threads, and both can find the folder absent: the second `git worktree add`
/// then fails on a directory the first is still filling, and a card refuses to
/// open over a race nobody can see. Making a tree takes about a second and is
/// rare, so one lock across all of them costs nothing that matters; the check
/// that the folder exists is repeated under it.
static MAKING: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The tree for `name` under `root`, made if it is not there yet.
///
/// Idempotent, and that is load-bearing rather than tidy: `spawn_now` reaches
/// this on *every* spawn, including waking a card that has been dormant since
/// yesterday. Returning the existing path is what puts that card back in the
/// tree it has been working in — and it is also why the folder spelling has to
/// match the CLI's, since the trees made before this module exist under that
/// name and would otherwise each gain a duplicate beside them.
pub fn ensure(root: &str, name: &str) -> Result<String, String> {
    ensure_at(root, name, None)
}

/// `ensure`, with the commit a new branch starts from chosen by the caller.
///
/// A worktree group is opened by an orchestrator that will merge it back into
/// the tree it is standing in, so its base is *that tree's* `HEAD` rather than
/// the remote's main: an orchestrator that has committed a scaffold and not yet
/// pushed it would otherwise hand its cards a tree without the scaffold. No
/// fetch either — the base is a local commit, and the network has nothing to
/// say about it. `None` is the ladder below, unchanged.
pub fn ensure_at(root: &str, name: &str, base: Option<&str>) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("a worktree needs a branch name".into());
    }
    let dir = dir_for(root, name);
    let path = dir.to_string_lossy().to_string();

    /* Already there — the dormant-card path, and the overwhelmingly common one
       once a wall has been up for a day. Nothing is verified about it beyond
       existing: a tree somebody has moved or deleted the guts of is a mess this
       cannot mend, and git will say so more precisely than a check here would
       when the agent runs its first command. */
    if dir.exists() {
        return Ok(path);
    }
    let _making = MAKING.lock().unwrap_or_else(|e| e.into_inner());
    if dir.exists() {
        return Ok(path);
    }

    /* A clear refusal rather than git's, since this is the one failure a person
       can do something about: the territory is not a repository, so there is
       nothing to branch. */
    if !run(root, &["rev-parse", "--git-dir"]).0 {
        return Err(format!("{root} is not a git repository, so it has no branches"));
    }

    /* Best effort, and deliberately before the base is chosen. "Based off
       origin/main" is a claim about the *remote's* main, and a remote-tracking
       ref is only as fresh as the last fetch — Skein's own fetch clock runs in
       minutes, so without this a tree made just after somebody else's push
       starts a commit behind and the first rebase is a surprise. Failure is
       ignored on purpose: offline, or a credential that has expired, is not a
       reason to refuse to open a card, and the local ref is still a reasonable
       base. */
    let base = match base.map(str::trim).filter(|b| !b.is_empty()) {
        Some(b) => b.to_string(),
        None => {
            let _ = run(root, &["fetch", "origin", "--quiet"]);
            base_ref(root)
        }
    };
    /* An existing branch is checked out rather than re-created. Typing a name
       that already exists reads as "put a card on that branch", which is a
       thing people do — and `-b` on an existing branch is a hard error, so the
       alternative is refusing something reasonable. */
    let exists = run(root, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{name}")]).0;
    let args: Vec<&str> = if exists {
        vec!["worktree", "add", &path, name]
    } else {
        /* `--no-track`, and it is not a nicety. Branching from a remote-tracking
           ref makes git set that ref as the new branch's upstream: probed
           2026-08-25, `worktree add -b feat/x <dir> origin/main` leaves
           `branch.feat/x.merge = refs/heads/main`, so the branch's idea of
           "upstream" is main itself. `git push` from there targets **main** —
           refused by `push.default=simple` (which is what this machine has, so
           the failure would have been a baffling error rather than a disaster),
           and not refused at all under `push.default=upstream`. Nothing about
           the base you branched from should decide where you publish to.

           No upstream at all is the right state, and Skein already knows what
           to do with it: `actions.ts` offers "publish" — `git push -u origin
           HEAD` — for a branch that has none, which sets the upstream to a
           remote branch of the same name. That is exactly the config the
           CLI-made worktree branches ended up carrying. */
        vec!["worktree", "add", "--no-track", "-b", name, &path, &base]
    };

    let (ok, _, err) = run(root, &args);
    if !ok {
        /* git's own words, which are better than anything invented here: it
           names the other worktree when a branch is already checked out, and
           that is exactly the thing the person needs to know. */
        let why = if err.is_empty() { "git worktree add failed".into() } else { err };
        return Err(format!("could not make a worktree for {name}: {why}"));
    }
    seed(root, &dir);
    Ok(path)
}

/// The file at a repository's root naming what a new tree needs that git does
/// not carry. The name is Claude Code's own, so a repository that already
/// declares one for the CLI's worktrees gets the same files in the wall's.
pub const INCLUDE_FILE: &str = ".worktreeinclude";

/// Copy into a fresh tree the ignored files it cannot build without.
///
/// A worktree is a checkout, so it has exactly what git tracks — and a
/// repository's working copy usually holds things git deliberately does not:
/// a `.env`, a downloaded runtime, a generated key. This one is the case that
/// found it: skein's `src-tauri/sherpa/` (the voice runtime, gitignored because
/// it is fetched) is absent from a new tree, and `cargo build` there fails in
/// tauri's resource check after two minutes of compiling — measured 2026-11-02
/// on the first group tree ever made. A card in a group is a card that cannot
/// build until somebody notices why.
///
/// `.worktreeinclude` at the root lists them, one per line: a path relative to
/// the root, a directory taking everything under it, `*` allowed in the last
/// component, `#` for a comment. Only what is in the main tree is copied, only
/// into a tree being made for the first time, and never over a file already
/// there — so it cannot clobber anything git checked out. A path that climbs
/// out of the root is ignored rather than followed. Best effort throughout: a
/// file that will not copy costs that file, never the card.
pub fn seed(root: &str, tree: &Path) -> Vec<String> {
    let Ok(listing) = std::fs::read_to_string(Path::new(root).join(INCLUDE_FILE)) else {
        return Vec::new();
    };
    let mut copied = Vec::new();
    for line in listing.lines() {
        let rel = line.trim().trim_end_matches(['/', '\\']);
        if rel.is_empty() || rel.starts_with('#') {
            continue;
        }
        let rel_path = Path::new(rel);
        if rel_path.is_absolute()
            || rel_path.components().any(|c| !matches!(c, std::path::Component::Normal(_)))
        {
            continue;
        }
        for found in expand(Path::new(root), rel_path) {
            let Ok(inside) = found.strip_prefix(root) else { continue };
            if copy_missing(&found, &tree.join(inside)) {
                copied.push(inside.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    copied
}

/// The paths under `root` a `.worktreeinclude` line names: itself, or — with a
/// `*` in its last component — every sibling that matches.
fn expand(root: &Path, rel: &Path) -> Vec<PathBuf> {
    let last = rel.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if !last.contains('*') {
        let p = root.join(rel);
        return if p.exists() { vec![p] } else { Vec::new() };
    }
    let parent = root.join(rel.parent().unwrap_or(Path::new("")));
    let Ok(entries) = std::fs::read_dir(&parent) else { return Vec::new() };
    entries
        .flatten()
        .filter(|e| wildcard(&last, &e.file_name().to_string_lossy()))
        .map(|e| e.path())
        .collect()
}

/// `*` matches any run of characters; nothing else is special.
fn wildcard(pattern: &str, name: &str) -> bool {
    let parts: Vec<&str> = pattern.split('*').collect();
    let mut rest = name;
    for (i, part) in parts.iter().enumerate() {
        if i == 0 {
            let Some(r) = rest.strip_prefix(part) else { return false };
            rest = r;
        } else if i == parts.len() - 1 {
            return rest.ends_with(part);
        } else {
            let Some(at) = rest.find(part) else { return false };
            rest = &rest[at + part.len()..];
        }
    }
    rest.is_empty()
}

/// Copy a file or a whole directory, skipping anything already at the
/// destination. Whether anything was copied.
fn copy_missing(from: &Path, to: &Path) -> bool {
    if from.is_dir() {
        let _ = std::fs::create_dir_all(to);
        let Ok(entries) = std::fs::read_dir(from) else { return false };
        let mut any = false;
        for e in entries.flatten() {
            any |= copy_missing(&e.path(), &to.join(e.file_name()));
        }
        any
    } else if to.exists() {
        false
    } else {
        if let Some(parent) = to.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::copy(from, to).is_ok()
    }
}

/// What became of a group's tree when its last card closed.
#[derive(Debug, PartialEq, Eq)]
pub enum Retired {
    /// Not a group, or no tree on disk: there was nothing to take down.
    Nothing,
    /// The tree is gone, and its branch with it when git agreed it was merged.
    Removed,
    /// Left exactly as it was, and why — the work in it is not anywhere else.
    Kept(String),
}

/// Take a worktree group's tree down, **only if nothing in it would be lost.**
///
/// Called when the last open card in a group closes. The rule is the one Lyss
/// gave the design — never delete unmerged work — and it is enforced three
/// times over rather than once, because a wrong answer here destroys the very
/// thing the group was opened to make:
///
/// - **Clean**: `git status --porcelain` says nothing, so there is no edit and
///   no new file that is not in a commit. Ignored files (`node_modules`, a
///   `target`) are not work and do not count.
/// - **Merged**: the branch's tip is an ancestor of the main tree's `HEAD` or
///   of the remote's main — so every commit the group made is on a branch that
///   outlives it. A group merged back by rebase and fast-forward passes; one
///   whose commits were cherry-picked does not, and is kept, which is the safe
///   way to be wrong.
/// - **Git agrees**: the removal is `git worktree remove` without `--force`,
///   which refuses a dirty tree on its own, and the branch goes with `-d`,
///   which refuses an unmerged one. Both checks above could be wrong and git
///   would still say no.
///
/// Only a `wt/` tree is ever considered: a branch a person typed is theirs to
/// tidy, and the wall never decided to make it.
pub fn retire(root: &str, name: &str) -> Retired {
    let Some(_) = group_of(name) else { return Retired::Nothing };
    let branch = name.trim();
    let dir = dir_for(root, branch);
    if !dir.exists() {
        return Retired::Nothing;
    }
    let d = dir.to_string_lossy().to_string();
    /* Under the making lock, so a card being born into this group on another
       thread is not handed a folder this is in the middle of deleting. */
    let _making = MAKING.lock().unwrap_or_else(|e| e.into_inner());

    let (ok, status, err) = run(&d, &["status", "--porcelain", "--untracked-files=normal"]);
    if !ok {
        return Retired::Kept(format!("git could not read the tree ({err}), so it was left alone"));
    }
    if !status.is_empty() {
        let n = status.lines().count();
        return Retired::Kept(format!(
            "it has uncommitted work — {n} path{} changed or new",
            if n == 1 { "" } else { "s" }
        ));
    }
    let tip = format!("refs/heads/{branch}");
    let base = base_ref(root);
    let merged = ["HEAD", base.as_str()]
        .iter()
        .any(|into| run(root, &["merge-base", "--is-ancestor", &tip, into]).0);
    if !merged {
        let (_, ahead, _) = run(root, &["rev-list", "--count", &format!("HEAD..{tip}")]);
        let ahead = if ahead.is_empty() { "some".to_string() } else { ahead };
        return Retired::Kept(format!(
            "{ahead} commit(s) on {branch} are not on the main tree's branch — merge it back \
             (rebase onto it, then fast-forward) or delete the branch yourself"
        ));
    }
    let (ok, _, err) = run(root, &["worktree", "remove", &d]);
    if !ok {
        return Retired::Kept(format!("git would not remove it: {err}"));
    }
    let _ = run(root, &["branch", "-d", branch]);
    Retired::Removed
}

#[cfg(test)]
mod tests {
    use super::*;

    /* ── groups ────────────────────────────────────────────────────────── */

    #[test]
    fn a_key_is_folded_to_one_spelling() {
        assert_eq!(group_key("  Auth ").unwrap(), "auth");
        assert_eq!(group_key("ui-pass_2.b").unwrap(), "ui-pass_2.b");
    }

    #[test]
    fn a_key_that_cannot_be_a_branch_is_refused() {
        for bad in ["", "   ", "a/b", "two words", ".hidden", "-x", "x.", "a..b", "x.lock", "é"] {
            assert!(group_key(bad).is_err(), "{bad:?} was accepted");
        }
        assert!(group_key(&"k".repeat(MAX_KEY + 1)).is_err());
        assert!(group_key(&"k".repeat(MAX_KEY)).is_ok());
    }

    #[test]
    fn one_key_is_one_tree_and_two_keys_are_two() {
        /* The whole mapping: the same key from two cards resolves to one
           folder, so `ensure` finds the second card's tree already made, and
           a different key never lands in it. */
        let a1 = run_dir("C:/repo", Some(&group_branch(&group_key("A").unwrap())));
        let a2 = run_dir("C:/repo", Some(&group_branch(&group_key("a").unwrap())));
        let b = run_dir("C:/repo", Some(&group_branch(&group_key("b").unwrap())));
        assert_eq!(a1, a2);
        assert_ne!(a1, b);
        assert!(a1.replace('\\', "/").ends_with(".claude/worktrees/wt+a"), "{a1}");
    }

    #[test]
    fn only_the_wt_namespace_is_a_group() {
        assert_eq!(group_of("wt/auth"), Some("auth"));
        assert_eq!(group_of("feat/auth"), None);
        assert_eq!(group_of("wt/"), None);
    }

    /* A real repository, because `retire` is a decision about what git says
       and a stub would only test the stub. */
    struct Repo(PathBuf);
    impl Repo {
        fn new(tag: &str) -> Repo {
            let dir = std::env::temp_dir()
                .join(format!("volery-wt-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let r = Repo(dir);
            r.git(&["init", "-q", "-b", "main"]);
            r.git(&["config", "user.email", "t@example.invalid"]);
            r.git(&["config", "user.name", "t"]);
            std::fs::write(r.0.join(".gitignore"), "ignored/\n").unwrap();
            std::fs::write(r.0.join("a.txt"), "one\n").unwrap();
            r.git(&["add", "."]);
            r.git(&["commit", "-q", "-m", "one"]);
            r
        }
        fn root(&self) -> String {
            self.0.to_string_lossy().into_owned()
        }
        fn git(&self, args: &[&str]) -> String {
            let (ok, out, err) = run(&self.root(), args);
            assert!(ok, "git {args:?}: {err}");
            out
        }
        fn group(&self, key: &str) -> String {
            let head = self.git(&["rev-parse", "HEAD"]);
            ensure_at(&self.root(), &group_branch(key), Some(&head)).unwrap()
        }
        fn commit_in(&self, dir: &str, file: &str) {
            std::fs::write(Path::new(dir).join(file), "work\n").unwrap();
            assert!(run(dir, &["add", file]).0);
            assert!(run(dir, &["commit", "-q", "-m", file]).0);
        }
    }
    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn two_cards_in_one_group_share_a_tree_and_its_edits() {
        let r = Repo::new("share");
        let first = r.group("a");
        let second = r.group("a");
        assert_eq!(first, second);
        std::fs::write(Path::new(&first).join("b.txt"), "x").unwrap();
        assert!(Path::new(&second).join("b.txt").exists());
        let other = r.group("b");
        assert!(!Path::new(&other).join("b.txt").exists(), "a second group saw the first's edit");
        assert!(!r.0.join("b.txt").exists(), "the main tree saw a group's edit");
        assert_eq!(r.git(&["rev-parse", "--abbrev-ref", "HEAD"]), "main");
        let (_, branch, _) = run(&first, &["rev-parse", "--abbrev-ref", "HEAD"]);
        assert_eq!(branch, "wt/a");
    }

    #[test]
    fn a_group_starts_from_the_commit_it_was_given() {
        /* An unpushed local commit is the orchestrator's scaffold; a group
           based on the remote's main would not have it. */
        let r = Repo::new("base");
        r.commit_in(&r.root(), "scaffold.txt");
        let tree = r.group("a");
        assert!(Path::new(&tree).join("scaffold.txt").exists());
    }

    #[test]
    fn a_dirty_group_is_kept() {
        let r = Repo::new("dirty");
        let tree = r.group("a");
        std::fs::write(Path::new(&tree).join("new.txt"), "unsaved").unwrap();
        assert!(matches!(retire(&r.root(), "wt/a"), Retired::Kept(why) if why.contains("uncommitted")));
        assert!(Path::new(&tree).join("new.txt").exists());
    }

    #[test]
    fn an_unmerged_group_is_kept() {
        let r = Repo::new("unmerged");
        let tree = r.group("a");
        r.commit_in(&tree, "feature.txt");
        match retire(&r.root(), "wt/a") {
            Retired::Kept(why) => assert!(why.contains("1 commit"), "{why}"),
            other => panic!("unmerged work was not kept: {other:?}"),
        }
        assert!(Path::new(&tree).exists());
        assert!(run(&r.root(), &["rev-parse", "--verify", "refs/heads/wt/a"]).0);
    }

    #[test]
    fn a_merged_clean_group_is_taken_down_with_its_ignored_files() {
        let r = Repo::new("merged");
        let tree = r.group("a");
        r.commit_in(&tree, "feature.txt");
        /* What the orchestrator is told to do: rebase onto main (a no-op
           here), then fast-forward main to the group. */
        r.git(&["merge", "--ff-only", "wt/a"]);
        /* A build output: ignored, and not work. */
        std::fs::create_dir_all(Path::new(&tree).join("ignored")).unwrap();
        std::fs::write(Path::new(&tree).join("ignored").join("big.bin"), "x").unwrap();
        assert_eq!(retire(&r.root(), "wt/a"), Retired::Removed);
        assert!(!Path::new(&tree).exists());
        assert!(!run(&r.root(), &["rev-parse", "--verify", "refs/heads/wt/a"]).0);
        assert!(r.0.join("feature.txt").exists(), "the merged work is on main");
    }

    #[test]
    fn an_empty_group_is_taken_down() {
        /* Opened, nothing committed, nothing left behind: its tip is the base,
           which is on main already. */
        let r = Repo::new("empty");
        let tree = r.group("a");
        assert_eq!(retire(&r.root(), "wt/a"), Retired::Removed);
        assert!(!Path::new(&tree).exists());
    }

    #[test]
    fn a_new_tree_is_seeded_with_what_worktreeinclude_names() {
        let r = Repo::new("seed");
        std::fs::write(
            r.0.join(".gitignore"),
            "ignored/\nruntime/\n.env*\nnot-listed.txt\n",
        )
        .unwrap();
        std::fs::create_dir_all(r.0.join("runtime").join("lib")).unwrap();
        std::fs::write(r.0.join("runtime").join("lib").join("a.dll"), "dll").unwrap();
        std::fs::write(r.0.join(".env.local"), "KEY=1").unwrap();
        std::fs::write(r.0.join("not-listed.txt"), "x").unwrap();
        std::fs::write(
            r.0.join(INCLUDE_FILE),
            "# what a fresh tree needs\nruntime/\n.env*\n../outside\nC:\\abs\n",
        )
        .unwrap();
        r.git(&["add", ".gitignore", INCLUDE_FILE]);
        r.git(&["commit", "-q", "-m", "include"]);
        let tree = r.group("a");
        let t = Path::new(&tree);
        assert!(t.join("runtime").join("lib").join("a.dll").exists());
        assert!(t.join(".env.local").exists());
        assert!(!t.join("not-listed.txt").exists());
        /* Ignored, so the seed does not make the tree dirty — which is what
           lets an untouched group still be retired. */
        let (_, status, _) = run(&tree, &["status", "--porcelain"]);
        assert!(status.is_empty(), "{status}");
    }

    #[test]
    fn the_wildcard_matches_what_a_shell_would() {
        assert!(wildcard(".env*", ".env"));
        assert!(wildcard(".env*", ".env.local"));
        assert!(wildcard("*.dll", "a.dll"));
        assert!(wildcard("a*b*c", "aXXbYYc"));
        assert!(!wildcard("*.dll", "a.lib"));
        assert!(!wildcard(".env*", "x.env"));
    }

    #[test]
    fn a_branch_a_person_named_is_never_retired() {
        let r = Repo::new("person");
        let tree = ensure_at(&r.root(), "feat/x", Some("HEAD")).unwrap();
        assert_eq!(retire(&r.root(), "feat/x"), Retired::Nothing);
        assert!(Path::new(&tree).exists());
    }

    #[test]
    fn the_slug_matches_what_the_cli_makes() {
        /* Not a preference — the folders on disk from before this module exist
           under exactly this spelling, and `ensure` has to find them. */
        assert_eq!(slug("feat/async-auth"), "feat+async-auth");
        assert_eq!(
            slug("feat/store-productivity-improvements"),
            "feat+store-productivity-improvements"
        );
    }

    #[test]
    fn a_nested_branch_folds_every_separator() {
        assert_eq!(slug("user/lyss/fix/thing"), "user+lyss+fix+thing");
    }

    #[test]
    fn dots_and_underscores_survive() {
        /* `feat/v2.1_fix` reads better kept than folded, and both characters are
           fine in a path. */
        assert_eq!(slug("feat/v2.1_fix"), "feat+v2.1_fix");
    }

    #[test]
    fn anything_a_path_cannot_hold_becomes_a_dash() {
        assert_eq!(slug("feat/a:b*c?d"), "feat+a-b-c-d");
        assert_eq!(slug("feat/two words"), "feat+two-words");
    }

    #[test]
    fn a_card_with_no_branch_stands_in_its_territory() {
        assert_eq!(run_dir("C:/x", None), "C:/x");
        assert_eq!(
            run_dir("C:/x", Some("   ")),
            "C:/x",
            "a name that is only whitespace is no name — `ensure` refuses it too"
        );
    }

    #[test]
    fn a_card_with_a_branch_stands_where_ensure_would_put_it() {
        /* The two must not be able to disagree: `ensure` is what the *running*
           child gets and `run_dir` is what everything looking the card up gets,
           and a transcript written under one and read under the other is the
           bug this pair exists to close. Both go through `dir_for`. */
        assert_eq!(
            run_dir("C:/x", Some("feat/async-auth")),
            dir_for("C:/x", "feat/async-auth").to_string_lossy()
        );
        assert!(run_dir("C:/x", Some("feat/async-auth")).contains("feat+async-auth"));
    }

    #[test]
    fn a_name_that_would_be_no_folder_at_all_is_still_a_folder() {
        /* Neither is reachable from a branch name git accepts. Both are a path
           built from typed text, which is the reason to be sure. */
        assert_eq!(slug(".."), "worktree");
        assert_eq!(slug(""), "worktree");
    }

    #[test]
    fn the_tree_goes_where_the_cli_put_it() {
        let dir = dir_for("C:\\repo", "feat/x");
        let s = dir.to_string_lossy().replace('\\', "/");
        assert!(s.ends_with(".claude/worktrees/feat+x"), "{s}");
    }

    #[test]
    fn an_empty_name_is_refused_before_anything_is_spawned() {
        assert!(ensure("C:\\repo", "   ").is_err());
    }
}
