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
fn run(dir: &str, args: &[&str]) -> (bool, String, String) {
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

/// The tree for `name` under `root`, made if it is not there yet.
///
/// Idempotent, and that is load-bearing rather than tidy: `spawn_now` reaches
/// this on *every* spawn, including waking a card that has been dormant since
/// yesterday. Returning the existing path is what puts that card back in the
/// tree it has been working in — and it is also why the folder spelling has to
/// match the CLI's, since the trees made before this module exist under that
/// name and would otherwise each gain a duplicate beside them.
pub fn ensure(root: &str, name: &str) -> Result<String, String> {
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
    let _ = run(root, &["fetch", "origin", "--quiet"]);

    let base = base_ref(root);
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
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

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
