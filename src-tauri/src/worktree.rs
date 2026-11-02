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

/* ── who made a group ──────────────────────────────────────────────────────
 *
 * A `wt/` prefix is a *name*, and a name is not a fact about who made the
 * branch: a person can type `wt/spike` for a branch of their own, and two walls
 * (the installed one and a lab) can stand in one repository. So a group the
 * wall makes is marked in the repository's own config —
 * `branch.wt/<key>.voleryGroup = <this wall's identifier>` — and `retire` takes
 * down only a tree whose branch carries this wall's mark. A branch from before
 * the mark (Volery 0.94.0), a person's `wt/` branch and a lab's group all read
 * as "not ours", which keeps them: the safe way to be wrong. `branch -d` and
 * `branch -D` remove the section with the branch, so the mark cannot outlive
 * what it marks. */

static OWNER: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// Which wall this process is, for the group mark. Set once at launch from the
/// app's identifier (`dev.skein.studio`, or a lab's own), so a lab standing in
/// the same repository never takes down the installed wall's trees.
pub fn set_owner(identifier: &str) {
    let _ = OWNER.set(identifier.to_string());
}

fn owner() -> &'static str {
    OWNER.get().map(String::as_str).unwrap_or("volery")
}

const MARK_KEY: &str = "voleryGroup";

fn mark(root: &str, branch: &str) {
    /* Trees in one repository are made in parallel now, and `git config`
       refuses while another holds `config.lock`. An unmarked group is only
       ever kept, never lost — but kept for good, so try a few times. */
    for _ in 0..5 {
        if run(root, &["config", &format!("branch.{branch}.{MARK_KEY}"), owner()]).0 {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(150));
    }
}

/// Take the mark off a branch that has gone, and make sure it went. `git
/// branch -d` removes the section with the branch — but probed (second review,
/// git 2.55), with `config.lock` held by a tree being made beside it, it
/// deletes the ref, fails to rewrite the config and **exits 0**, leaving a mark
/// with no branch under it for the next `wt/<key>` to inherit.
fn unmark(root: &str, branch: &str) {
    for _ in 0..5 {
        let key = format!("branch.{branch}.{MARK_KEY}");
        if !run(root, &["config", "--get", &key]).0 {
            return;
        }
        let _ = run(root, &["config", "--remove-section", &format!("branch.{branch}")]);
        std::thread::sleep(std::time::Duration::from_millis(150));
    }
}

fn marked_by_us(root: &str, branch: &str) -> bool {
    let (ok, who, _) = run(root, &["config", "--get", &format!("branch.{branch}.{MARK_KEY}")]);
    ok && who == owner()
}

/// A name the wall may make a tree for. `wt/` is where groups live, and on a
/// case-folding disk the *folder* is what collides: `WT/Auth`, `wt+auth` and
/// `wt\auth` all land in `.claude/worktrees/wt+auth`, which would put a
/// person's branch into a group's checkout. So any name whose folder would be a
/// `wt+…` folder must be exactly a group's branch, spelled as `group_key`
/// spells it.
fn reserved(name: &str) -> Result<(), String> {
    if !slug(name).to_ascii_lowercase().starts_with("wt+") {
        return Ok(());
    }
    let exact = name
        .strip_prefix(GROUP_PREFIX)
        .is_some_and(|k| group_key(k).ok().as_deref() == Some(k));
    if exact {
        Ok(())
    } else {
        Err(format!(
            "{name:?} would share a folder with the wall's worktree groups (`wt/<key>`, at \
             `.claude/worktrees/wt+<key>`) — name the branch something that does not start \
             with `wt`"
        ))
    }
}

/// A lock per tree, for making it **and taking it down**.
///
/// Two cards spawned into one group a moment apart reach `ensure_at` on two
/// threads, and both can find the folder absent: the second `git worktree add`
/// then fails on a directory the first is still filling. And a card spawned
/// into a group while `retire` is taking it down must not be handed the folder
/// being deleted. So the lock is taken *before* the folder is looked at, on
/// every path including the one that only finds it — a fast path that skipped
/// it was exactly the gap a spawn could fall through into a dying tree. It is
/// never held across the slow part of a removal: `retire` moves the tree aside
/// to a tombstone under it and deletes the tombstone after letting go.
///
/// **Per tree, not one for the process**, because what it is held across is
/// slow: a network `git fetch` with no timeout when a tree is made off the
/// ladder, a seed of up to 2 GB, `status --ignored` and byte compares in a
/// retirement. With one lock every worktree card on the wall waited behind
/// any of those to wake (review, 2026-11-02). Keyed on the folder as a
/// case-folding disk sees it (`claim_key`), so `WT+x` and `wt+x` are one lock.
static TREE_LOCKS: std::sync::Mutex<Vec<(String, std::sync::Arc<std::sync::Mutex<()>>)>> =
    std::sync::Mutex::new(Vec::new());

fn tree_lock(dir: &Path) -> std::sync::Arc<std::sync::Mutex<()>> {
    let key = claim_key(dir);
    let mut all = TREE_LOCKS.lock().unwrap_or_else(|e| e.into_inner());
    /* Drop locks nobody holds or waits on, so the list is bounded by the trees
       in use rather than every tree ever made. */
    all.retain(|(_, l)| std::sync::Arc::strong_count(l) > 1);
    if let Some((_, l)) = all.iter().find(|(k, _)| *k == key) {
        return l.clone();
    }
    let l = std::sync::Arc::new(std::sync::Mutex::new(()));
    all.push((key, l.clone()));
    l
}

/* ── claims ────────────────────────────────────────────────────────────────
 *
 * The census `retire` asks is the store's, and the store only learns of a
 * spawned card when the front end writes its row — after `spawn:asked`, after
 * the tree was made. In that gap a group can look empty to a close on another
 * thread. A claim is the Rust side's word that a *named card* is being born
 * into a tree: written under the tree's lock by every `ensure_at`, and handed
 * to `retire`'s `in_use` under the same lock, which asks the store whether
 * each claimed card has a row yet. A card with no row is in use; a card with
 * one is the census's to count, open or closed.
 *
 * It was a clock first — two minutes — and both ways of reading a clock were
 * wrong: as a veto, a card closed inside its own two minutes left its tree
 * for good (found driving the lab); as a wait, a front end starved past two
 * minutes (2026-10-19's freeze) had its fresh tree retired before the row
 * landed, and the wake rebuilt it off the ladder without the orchestrator's
 * base (the second review). A card's id is the thing that is true either way.
 *
 * A wake does not claim — a woken card already has a row. Claims are dropped
 * after `CLAIM_KEEP`, which only bounds memory: a card whose row never landed
 * an hour after its birth was a spawn that failed, and its tree is the
 * sweep's. */

const CLAIM_KEEP: std::time::Duration = std::time::Duration::from_secs(3600);

static CLAIMS: std::sync::Mutex<Vec<(String, String, std::time::Instant)>> =
    std::sync::Mutex::new(Vec::new());

fn claim_key(dir: &Path) -> String {
    dir.to_string_lossy().replace('\\', "/").to_ascii_lowercase()
}

fn claim(dir: &Path, card: &str) {
    let key = claim_key(dir);
    let mut c = CLAIMS.lock().unwrap_or_else(|e| e.into_inner());
    c.retain(|(_, _, at)| at.elapsed() < CLAIM_KEEP);
    c.push((key, card.to_string(), std::time::Instant::now()));
}

/// The cards born into `dir` that `retire` must ask the store about.
fn claims_on(dir: &Path) -> Vec<String> {
    let key = claim_key(dir);
    let c = CLAIMS.lock().unwrap_or_else(|e| e.into_inner());
    c.iter()
        .filter(|(k, _, at)| *k == key && at.elapsed() < CLAIM_KEEP)
        .map(|(_, card, _)| card.clone())
        .collect()
}

#[cfg(test)]
fn unclaim(dir: &Path) {
    let key = claim_key(dir);
    CLAIMS.lock().unwrap_or_else(|e| e.into_inner()).retain(|(k, _, _)| *k != key);
}

/* ── is the folder still a tree ────────────────────────────────────────────
 *
 * `<tree>/.git` is a one-line file naming the tree's own git directory, and it
 * is the only thing that makes the folder a worktree. Without it git does what
 * it does in any folder: walks *up* — and up from `.claude/worktrees/wt+x` is
 * the main repository, on main, with main's index. Probed 2026-11-02 on git
 * 2.55.0.windows.3: `git worktree remove` on a tree holding a `node_modules`
 * junction returns **0**, unregisters the tree, deletes the tracked files and
 * the `.git` link, and leaves the folder holding the junction; with an ignored
 * file held open it returns 255 having done the same. `rev-parse
 * --show-toplevel` inside either leftover answers the main repository. A card
 * sent there commits on main and nothing says so. */

fn lost_its_link(dir: &Path) -> bool {
    matches!(
        std::fs::symlink_metadata(dir.join(".git")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound
    )
}

fn common_dir(dir: &Path) -> Option<PathBuf> {
    let (ok, out, _) = run(
        &dir.to_string_lossy(),
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    );
    if !ok || out.is_empty() {
        return None;
    }
    std::fs::canonicalize(out).ok()
}

/// A folder that has its `.git` but answers to some other repository is not a
/// tree this one can hand a card. Unknown on either side is let through: the
/// `.git` is there, so git will fail loudly rather than walk up.
fn same_repository(root: &str, dir: &Path) -> Result<(), String> {
    match (common_dir(Path::new(root)), common_dir(dir)) {
        (Some(a), Some(b)) if a != b => Err(format!(
            "{} is a checkout of another repository ({}), not a worktree of {root}",
            dir.display(),
            b.display()
        )),
        _ => Ok(()),
    }
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Rename a folder that is no longer a tree out of the way, beside where it
/// was. Nothing in it is deleted — it is whatever a removal could not finish,
/// and only a person can say whether any of it matters.
fn move_aside(dir: &Path) -> Result<PathBuf, String> {
    let name = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let to = dir.with_file_name(format!(".leftover-{name}-{}", unix_now()));
    std::fs::rename(dir, &to).map_err(|e| {
        format!(
            "{} is not a git worktree any more (a removal that did not finish left it), and it \
             could not be moved aside ({e}) — something may still have a file open in it. \
             Move or delete that folder, then try again",
            dir.display()
        )
    })?;
    Ok(to)
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
    make(root, name, None, None).map(|e| e.dir)
}

/// What `ensure_at` found or did — the receipt needs more than a path.
#[derive(Debug, Default)]
pub struct Ensured {
    pub dir: String,
    /// The tree was made by this call, rather than found.
    pub made: bool,
    /// The branch already existed and was checked out as it was, at this
    /// commit — so the base this call was given was **not** used.
    pub resumed: Option<String>,
    /// An earlier group's branch of the same name, already merged, was deleted
    /// first so the group could start where it was asked to. Its old tip.
    pub replaced: Option<String>,
    /// A leftover folder at the tree's path was moved here first.
    pub moved_aside: Option<String>,
}

/// `ensure`, with the commit a new branch starts from chosen by the caller.
///
/// A worktree group is opened by an orchestrator that will merge it back into
/// the tree it is standing in, so its base is *that tree's* `HEAD` rather than
/// the remote's main: an orchestrator that has committed a scaffold and not yet
/// pushed it would otherwise hand its cards a tree without the scaffold. No
/// fetch either — the base is a local commit, and the network has nothing to
/// say about it. `None` is the ladder below, unchanged.
///
/// This is the *birth* path (`spawn`, and a spawn over the flyway), so it also
/// claims a group's tree for `card` against a `retire` racing it.
pub fn ensure_at(root: &str, name: &str, base: Option<&str>, card: &str) -> Result<Ensured, String> {
    make(root, name, base, Some(card))
}

fn make(root: &str, name: &str, base: Option<&str>, born: Option<&str>) -> Result<Ensured, String> {
    let birth = born.is_some();
    let name = name.trim();
    if name.is_empty() {
        return Err("a worktree needs a branch name".into());
    }
    /* At a birth the name is checked whatever is on disk. A wake is asked
       about a name already on a row, and is held to it only if it is about to
       make something — a card from before groups whose branch happens to fold
       to `wt+…` must still be able to come back to its own tree. */
    if birth {
        reserved(name)?;
    }
    let group = group_of(name).is_some();
    let dir = dir_for(root, name);
    let path = dir.to_string_lossy().to_string();

    let lock = tree_lock(&dir);
    let _making = lock.lock().unwrap_or_else(|e| e.into_inner());
    if let (true, Some(card)) = (group, born) {
        claim(&dir, card);
    }

    /* Already there — the dormant-card path, and the overwhelmingly common one
       once a wall has been up for a day. Verified only as far as it can go
       wrong silently: a folder with no `.git` is a removal's leftover and is
       moved aside rather than handed out (see "is the folder still a tree"),
       and one answering to another repository is refused. Anything else wrong
       with a real tree, git says more precisely than a check here would. */
    let mut moved_aside = None;
    if dir.exists() {
        if !lost_its_link(&dir) {
            same_repository(root, &dir)
                .map_err(|why| format!("could not use the worktree for {name}: {why}"))?;
            if group {
                holds_the_group(&dir, name)
                    .map_err(|why| format!("could not use the worktree for {name}: {why}"))?;
            }
            return Ok(Ensured { dir: path, ..Ensured::default() });
        }
        moved_aside = Some(move_aside(&dir)?.to_string_lossy().into_owned());
    }

    /* A clear refusal rather than git's, since this is the one failure a person
       can do something about: the territory is not a repository, so there is
       nothing to branch. */
    if !run(root, &["rev-parse", "--git-dir"]).0 {
        return Err(format!("{root} is not a git repository, so it has no branches"));
    }
    if !birth {
        reserved(name)?;
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
       alternative is refusing something reasonable.

       For a group that is a different sentence, and both halves are said back
       (`Ensured`). A branch this wall marked as a group, whose every commit is
       already on a branch that outlives it, is a finished group whose branch a
       removal could not delete — so it is deleted now and the group starts
       where it was asked to, rather than silently on an old base. Anything
       else — unmerged, or not marked ours — is work, and is resumed as it is,
       with the caller told the base it gave was not used. */
    let full = format!("refs/heads/{name}");
    let (exists, tip, _) = run(root, &["rev-parse", "--verify", "--quiet", &full]);
    let mut resumed = None;
    let mut replaced = None;
    if exists && !tip.is_empty() {
        /* Only at a birth. A wake or a move into a group whose tree has gone
           is a card coming back to *its* branch, and is put back on it. */
        if birth
            && group
            && marked_by_us(root, name)
            && !checked_out(root, &full)
            && merged_somewhere(root, name, &tip)
        {
            let (ok, _, err) = run(root, &["update-ref", "-d", &full, &tip]);
            if !ok {
                return Err(format!(
                    "could not make a worktree for {name}: an old, merged {name} is in the way \
                     and git would not delete it: {err}"
                ));
            }
            unmark(root, name);
            replaced = Some(tip);
        } else {
            resumed = Some(tip);
        }
    }
    let args: Vec<&str> = if resumed.is_some() {
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
    if group && resumed.is_none() {
        mark(root, name);
    }
    seed(root, &dir);
    Ok(Ensured { dir: path, made: true, resumed, replaced, moved_aside })
}

/// Every commit up to `tip` is on a branch that outlives the group `branch`:
/// the branch the main tree is *on*, or the remote's main.
///
/// The main tree counts only through `symbolic-ref`, never its raw `HEAD`
/// (review, 2026-11-02, both reproduced). A detached `HEAD` — a paused rebase,
/// a bisect, `switch --detach wt/x` to have a look — is on no branch, so
/// "merged into it" protects nothing once it moves. And a main tree that has
/// the group's own branch checked out is trivially "merged" with it: the
/// branch would be deleted out from under the person standing on it. `HEAD`
/// from `base_ref`'s last rung is the same raw `HEAD` and is skipped too.
fn merged_somewhere(root: &str, branch: &str, tip: &str) -> bool {
    let own = format!("refs/heads/{branch}");
    let mut into: Vec<String> = Vec::new();
    let (ok, head, _) = run(root, &["symbolic-ref", "-q", "HEAD"]);
    if ok && !head.is_empty() && !head.eq_ignore_ascii_case(&own) {
        into.push(head);
    }
    let base = base_ref(root);
    if base != "HEAD" && !base.eq_ignore_ascii_case(branch) {
        into.push(base);
    }
    into.iter().any(|i| run(root, &["merge-base", "--is-ancestor", tip, i]).0)
}

/// Some worktree — the main tree included — has `full` checked out.
fn checked_out(root: &str, full: &str) -> bool {
    let (ok, list, _) = run(root, &["worktree", "list", "--porcelain"]);
    !ok || list.lines().any(|l| l.strip_prefix("branch ").is_some_and(|b| b.eq_ignore_ascii_case(full)))
}

/// A group's folder that is on some *other* branch is not the group's tree —
/// a person's `wt+auth` branch, say, made before groups and slugged to the
/// same folder. Detached is allowed: that is a group mid-rebase or mid-bisect,
/// which is its own business.
fn holds_the_group(dir: &Path, branch: &str) -> Result<(), String> {
    let (ok, head, _) = run(&dir.to_string_lossy(), &["symbolic-ref", "-q", "HEAD"]);
    if ok && !head.is_empty() && head != format!("refs/heads/{branch}") {
        return Err(format!(
            "{} has {} checked out, not the group's branch {branch} — it is somebody else's tree",
            dir.display(),
            head.trim_start_matches("refs/heads/")
        ));
    }
    Ok(())
}

/// The file at a repository's root naming what a new tree needs that git does
/// not carry. The name is Claude Code's own, so a repository that already
/// declares one for the CLI's worktrees gets the same files in the wall's.
pub const INCLUDE_FILE: &str = ".worktreeinclude";

/// The most a seed copies into one tree. A runtime, a `.env` and a key are
/// megabytes; a line that names something far bigger (`*`, or a build folder)
/// is a mistake, and filling the disk is the worst way to find it.
const SEED_BUDGET: u64 = 2 << 30;

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
///
/// **And it never follows a link or walks into a tree.** It runs under
/// the tree's lock, so a line of `*` or `.claude/` that walked into
/// `.claude/worktrees/` — which holds the tree being seeded — would copy the
/// tree into itself until the disk filled or the stack ran out, with every
/// spawn on the wall waiting behind it. So `.git` and `.claude/worktrees` are
/// never entered, a symlink or junction is skipped rather than followed, and
/// the whole copy stops at `SEED_BUDGET`.
pub fn seed(root: &str, tree: &Path) -> Vec<String> {
    let Ok(listing) = std::fs::read_to_string(Path::new(root).join(INCLUDE_FILE)) else {
        return Vec::new();
    };
    let mut copied = Vec::new();
    let mut budget = SEED_BUDGET;
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
            if copy_missing(&found, &tree.join(inside), inside, &mut budget) {
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
        return if std::fs::symlink_metadata(&p).is_ok() { vec![p] } else { Vec::new() };
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

/// Never entered by a seed, wherever a line points: git's own directory, and
/// the folder every tree — including the one being seeded — lives in.
fn off_limits(rel: &Path) -> bool {
    let parts: Vec<String> = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_ascii_lowercase())
        .collect();
    parts.first().is_some_and(|p| p == ".git")
        || parts.windows(2).any(|w| w[0] == ".claude" && w[1] == "worktrees")
}

/// Copy a file or a whole directory, skipping anything already at the
/// destination, any link, and anything `off_limits`. Whether anything was
/// copied.
fn copy_missing(from: &Path, to: &Path, rel: &Path, budget: &mut u64) -> bool {
    if off_limits(rel) {
        return false;
    }
    let Ok(meta) = std::fs::symlink_metadata(from) else { return false };
    if meta.file_type().is_symlink() {
        return false;
    }
    if meta.is_dir() {
        let Ok(entries) = std::fs::read_dir(from) else { return false };
        let _ = std::fs::create_dir_all(to);
        let mut any = false;
        for e in entries.flatten() {
            if *budget == 0 {
                break;
            }
            any |= copy_missing(&e.path(), &to.join(e.file_name()), &rel.join(e.file_name()), budget);
        }
        any
    } else if std::fs::symlink_metadata(to).is_ok() || meta.len() > *budget {
        false
    } else {
        if let Some(parent) = to.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let ok = std::fs::copy(from, to).is_ok();
        if ok {
            *budget -= meta.len();
        }
        ok
    }
}

/* ── what may go with a tree ───────────────────────────────────────────────
 *
 * `git worktree remove` takes ignored files with it, and an ignored file is not
 * the same thing as a disposable one: `.scratch-<card>/` (where CLAUDE.md sends
 * every card's working files), a seeded `.env.local` somebody edited, a local
 * database, a generated key — all ignored, all somebody's. So `retire` asks
 * git for the ignored paths too and lets the tree go only when every one is
 * either build output by name, or a byte-for-byte copy of the same path in the
 * main tree (which is what a seed is until somebody edits it). */

/// Folder names whose contents a build or an install makes again.
const REGENERABLE_DIRS: &[&str] = &[
    "node_modules", "target", ".svelte-kit", "dist", "build", ".next", ".nuxt", ".turbo",
    ".vite", ".parcel-cache", ".cache", ".angular", "coverage", "__pycache__", ".pytest_cache",
    ".mypy_cache", ".ruff_cache", ".gradle", "obj", "intermediate", "binaries",
    "deriveddatacache",
];

/// File names a tool writes and nobody keeps.
fn regenerable_file(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n.ends_with(".tsbuildinfo")
        || n.ends_with(".pyc")
        || matches!(n.as_str(), ".ds_store" | "thumbs.db" | "desktop.ini")
}

/// `rel` as `git status --ignored` reports it: a directory it collapsed ends in
/// `/`. The name rule is asked only of such a directory, and only of its own
/// name — an ignored `build/secret.env` inside a *tracked* `build/` folder is
/// a file, not build output (review, 2026-11-02), and goes to the byte compare.
fn disposable(root: &Path, tree: &Path, rel: &str) -> bool {
    let is_dir = rel.ends_with('/');
    let rel = rel.trim_end_matches('/');
    let path = Path::new(rel);
    let last = path
        .file_name()
        .map(|n| n.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if is_dir && REGENERABLE_DIRS.contains(&last.as_str()) {
        return true;
    }
    if !is_dir && regenerable_file(&last) {
        return true;
    }
    same_as_main(&root.join(path), &tree.join(path))
}

/// Every file under `ours` has an identical twin at the same place under
/// `main`. A link anywhere is not a copy a seed made, so it is not identical.
fn same_as_main(main: &Path, ours: &Path) -> bool {
    let Ok(meta) = std::fs::symlink_metadata(ours) else { return false };
    if meta.file_type().is_symlink() {
        return false;
    }
    if meta.is_dir() {
        let Ok(entries) = std::fs::read_dir(ours) else { return false };
        return entries.flatten().all(|e| same_as_main(&main.join(e.file_name()), &e.path()));
    }
    match std::fs::symlink_metadata(main) {
        Ok(m) if m.is_file() && m.len() == meta.len() => {}
        _ => return false,
    }
    same_bytes(main, ours).unwrap_or(false)
}

fn same_bytes(a: &Path, b: &Path) -> std::io::Result<bool> {
    use std::io::Read;
    let (mut a, mut b) = (std::fs::File::open(a)?, std::fs::File::open(b)?);
    let (mut x, mut y) = (vec![0u8; 64 * 1024], vec![0u8; 64 * 1024]);
    loop {
        let n = a.read(&mut x)?;
        if n == 0 {
            return Ok(b.read(&mut y)? == 0);
        }
        let mut got = 0;
        while got < n {
            let m = b.read(&mut y[got..n])?;
            if m == 0 {
                return Ok(false);
            }
            got += m;
        }
        if x[..n] != y[..n] {
            return Ok(false);
        }
    }
}

/// What became of a group's tree when its last card closed.
#[derive(Debug, PartialEq, Eq)]
pub enum Retired {
    /// Not a group, no tree on disk, or a card is in it — open, or born into
    /// it with no row written yet: there was nothing to take down.
    Nothing,
    /// The tree is gone. `Some` says what happened to the branch when that was
    /// not simply "deleted with it".
    Removed(Option<String>),
    /// Left exactly as it was, and why — the work in it is not anywhere else.
    Kept(String),
    /// Off git's books and its branch handled, but something stayed on disk:
    /// what, and where. Nothing in it was work (every check passed first).
    Partial(String),
}

/// Take a worktree group's tree down, **only if nothing in it would be lost.**
///
/// Called when the last open card in a group closes, and by the launch sweep.
/// The rule is the one Lyss gave the design — never delete unmerged work —
/// and every check below is one a real tree failed (the 2026-11-02 review):
///
/// - **Ours**: the branch carries this wall's group mark. A person's `wt/`
///   branch, a lab's group and a group from before the mark are kept.
/// - **Nobody is in it**: no open card in the store's census and no card born
///   into it whose row is not written yet (`in_use`, handed the claims), asked
///   *under the lock*, so a spawn cannot slip between the look and the removal.
/// - **On its branch, mid-nothing**: `HEAD` is attached to `wt/<key>`, and no
///   rebase, merge, cherry-pick, revert or bisect is in progress. A detached
///   `HEAD` with commits on it leaves the branch at its base — "merged" — and
///   those commits would go with the tree and its reflog.
/// - **Clean**: nothing changed or untracked, and every *ignored* path is
///   build output or an unchanged copy from the main tree.
/// - **Merged**: the branch tip is an ancestor of the main tree's `HEAD` or of
///   the remote's main. Cherry-picked work fails this and is kept — the safe
///   way to be wrong.
/// - **Nothing has it open**: the tree is renamed to a tombstone with `git
///   worktree move`, which Windows refuses while any process has a file open
///   in it or stands in it (probed 2026-11-02: a handle of any share mode, or a
///   cwd, makes it fail with nothing changed). That is the check, and it cannot
///   race: a removal that has started is a removal of a tree nobody holds.
///
/// Then, outside the lock: links inside are unlinked (never followed), `git
/// worktree remove` runs without `--force`, and whatever it could not delete is
/// deleted — every byte of it having passed the checks above — or reported.
pub fn retire(root: &str, name: &str, in_use: &dyn Fn(&[String]) -> bool) -> Retired {
    let Some(_) = group_of(name) else { return Retired::Nothing };
    let branch = name.trim();
    let dir = dir_for(root, branch);
    let d = dir.to_string_lossy().to_string();

    let lock = tree_lock(&dir);
    let making = lock.lock().unwrap_or_else(|e| e.into_inner());
    if !dir.exists() || in_use(&claims_on(&dir)) {
        return Retired::Nothing;
    }
    if lost_its_link(&dir) {
        return Retired::Kept(format!(
            "{d} is not a git worktree any more (an earlier removal did not finish), so it was \
             left for you to look at"
        ));
    }
    if !marked_by_us(root, branch) {
        return Retired::Kept(format!(
            "{branch} is not marked as a group this wall made (a branch of yours, another \
             wall's, or a group from before the mark existed), so it is yours to remove"
        ));
    }
    let full = format!("refs/heads/{branch}");
    let (ok, head, _) = run(&d, &["symbolic-ref", "-q", "HEAD"]);
    if !ok || head != full {
        let at = if ok {
            head.trim_start_matches("refs/heads/").to_string()
        } else {
            "a detached HEAD".into()
        };
        return Retired::Kept(format!(
            "its checkout is on {at}, not {branch}, so commits made there may be on no branch"
        ));
    }
    let (ok, gd, err) = run(&d, &["rev-parse", "--path-format=absolute", "--git-dir"]);
    if !ok {
        return Retired::Kept(format!("git could not read the tree ({err}), so it was left alone"));
    }
    for (file, what) in [
        ("rebase-merge", "a rebase"),
        ("rebase-apply", "a rebase"),
        ("MERGE_HEAD", "a merge"),
        ("CHERRY_PICK_HEAD", "a cherry-pick"),
        ("REVERT_HEAD", "a revert"),
        ("BISECT_LOG", "a bisect"),
    ] {
        if Path::new(&gd).join(file).exists() {
            return Retired::Kept(format!("{what} is in progress in it"));
        }
    }

    let (ok, status, err) =
        run(&d, &["status", "--porcelain", "-z", "--ignored", "--untracked-files=normal"]);
    if !ok {
        return Retired::Kept(format!("git could not read the tree ({err}), so it was left alone"));
    }
    let mut changed = 0;
    let mut ignored = Vec::new();
    let mut entries = status.split('\0').filter(|e| !e.is_empty());
    while let Some(e) = entries.next() {
        if let Some(p) = e.strip_prefix("!! ") {
            ignored.push(p.to_string());
        } else {
            changed += 1;
            /* A rename or copy carries its old path as a second entry. */
            if matches!(e.as_bytes().first(), Some(b'R' | b'C')) {
                entries.next();
            }
        }
    }
    if changed > 0 {
        return Retired::Kept(format!(
            "it has uncommitted work — {changed} path{} changed or new",
            if changed == 1 { "" } else { "s" }
        ));
    }
    let keep: Vec<&String> = ignored.iter().filter(|p| !disposable(Path::new(root), &dir, p)).collect();
    if !keep.is_empty() {
        let shown: Vec<&str> = keep.iter().take(3).map(|s| s.as_str()).collect();
        let more = if keep.len() > 3 { format!(" and {} more", keep.len() - 3) } else { String::new() };
        return Retired::Kept(format!(
            "it holds ignored files that are not build output or an unchanged copy from the \
             main tree — {}{more} — and those are nowhere else. Delete them (or the tree) \
             yourself if they are not needed",
            shown.join(", ")
        ));
    }

    let (_, tip, _) = run(root, &["rev-parse", "--verify", "--quiet", &full]);
    if tip.is_empty() || !merged_somewhere(root, branch, &tip) {
        let (_, ahead, _) = run(root, &["rev-list", "--count", &format!("HEAD..{full}")]);
        let ahead = if ahead.is_empty() { "some".to_string() } else { ahead };
        return Retired::Kept(format!(
            "{ahead} commit(s) on {branch} are not on the main tree's branch — merge it back \
             (rebase onto it, then fast-forward) or delete the branch yourself"
        ));
    }

    let tomb = dir.with_file_name(format!(".retiring-{}-{}", slug(branch), unix_now()));
    let t = tomb.to_string_lossy().to_string();
    let (ok, _, err) = run(root, &["worktree", "move", &d, &t]);
    if !ok {
        return Retired::Kept(format!(
            "it could not be moved aside, which is what a process with a file open in it or \
             standing in it looks like ({err})"
        ));
    }
    /* The branch goes now, under the lock, so a card spawned into this key the
       moment the lock is let go starts a fresh group rather than finding the
       old branch held by a tombstone. Detached first, since git will not
       delete a branch a worktree has checked out. */
    if !run(&t, &["checkout", "--quiet", "--detach"]).0 {
        let _ = run(root, &["worktree", "move", &t, &d]);
        return Retired::Kept("git would not let go of its branch, so it was put back".into());
    }
    let branch_note = drop_branch(root, branch, &tip);
    drop(making);

    match finish(root, &tomb) {
        Ok(()) => Retired::Removed(branch_note),
        Err(why) => Retired::Partial(match branch_note {
            Some(b) => format!("{why}; and {b}"),
            None => why,
        }),
    }
}

/// Delete a retired group's branch. `git branch -d` first, because git
/// agreeing is worth having; but with no upstream it judges "merged" against
/// the main tree's `HEAD` alone, so a group merged into the remote's main while
/// the main tree stands on another branch is refused — and that refusal, once
/// swallowed, left a stale `wt/<key>` the next group of that name silently
/// resumed. `retire` has already proved the tip is on a branch that outlives
/// it, so the fallback deletes exactly that tip and nothing newer.
fn drop_branch(root: &str, branch: &str, tip: &str) -> Option<String> {
    let full = format!("refs/heads/{branch}");
    let gone = run(root, &["branch", "-d", branch]).0
        || run(root, &["update-ref", "-d", &full, tip]).0;
    if gone || !run(root, &["rev-parse", "--verify", "--quiet", &full]).0 {
        unmark(root, branch);
        return None;
    }
    let (_, _, err) = run(root, &["update-ref", "-d", &full, tip]);
    Some(format!("the branch {branch} was left in place: {err}"))
}

/// Delete a tombstone `retire` made: unlink what links into it, let git remove
/// it, then delete whatever git left. Also what the launch sweep calls for a
/// tombstone a crash interrupted — one exists only after every check passed.
pub fn finish(root: &str, tomb: &Path) -> Result<(), String> {
    unlink_links(tomb);
    let t = tomb.to_string_lossy().to_string();
    let (ok, _, err) = run(root, &["worktree", "remove", &t]);
    if !tomb.exists() {
        return Ok(());
    }
    if !ok && !lost_its_link(tomb) {
        return Err(format!(
            "git would not remove {t} ({err}), so it is still there and still a worktree; the \
             launch sweep tries again"
        ));
    }
    std::fs::remove_dir_all(tomb).map_err(|e| {
        format!("git let go of {t}, but some of it could not be deleted ({e}); the launch sweep tries again")
    })
}

/// Remove every symlink and junction under `dir` — the link, never what it
/// points at — without walking through any of them. A `node_modules` junction
/// is what made `git worktree remove` stop short with a 0 exit (see "is the
/// folder still a tree").
fn unlink_links(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        let Ok(meta) = std::fs::symlink_metadata(&p) else { continue };
        if meta.file_type().is_symlink() {
            /* A directory link (junction or symlink) goes with `remove_dir`, a
               file link with `remove_file`; neither touches the target. */
            if std::fs::remove_dir(&p).is_err() {
                let _ = std::fs::remove_file(&p);
            }
        } else if meta.is_dir() {
            unlink_links(&p);
        }
    }
}

/// What the sweep leaves alone: anything younger than this. A tombstone this
/// young may be one a retirement is still finishing, in this process or a lab
/// standing in the same repository; a tree this young may be one another
/// process is still birthing, whose claim this process cannot see.
pub const SWEEP_SPARES: std::time::Duration = std::time::Duration::from_secs(600);

fn younger_than(p: &Path, d: std::time::Duration) -> bool {
    std::fs::symlink_metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .map_or(true, |age| age < d)
}

/// What the launch sweep looks at under `root`: each `wt+<key>` folder as its
/// branch, and each tombstone a retirement left unfinished — less any that are
/// `SWEEP_SPARES` young.
pub fn leftovers(root: &str) -> (Vec<String>, Vec<PathBuf>) {
    let mut groups = Vec::new();
    let mut tombs = Vec::new();
    let Ok(entries) = std::fs::read_dir(Path::new(root).join(".claude").join("worktrees")) else {
        return (groups, tombs);
    };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if let Some(key) = name.strip_prefix("wt+") {
            if group_key(key).ok().as_deref() == Some(key)
                && !younger_than(&e.path().join(".git"), SWEEP_SPARES)
            {
                groups.push(group_branch(key));
            }
        } else if name.starts_with(".retiring-") {
            let secs = name.rsplit('-').next().and_then(|n| n.parse::<u64>().ok()).unwrap_or(0);
            if unix_now().saturating_sub(secs) >= SWEEP_SPARES.as_secs() {
                tombs.push(e.path());
            }
        }
    }
    (groups, tombs)
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
            std::fs::write(
                r.0.join(".gitignore"),
                "ignored/\ntarget/\nbuild/\nnode_modules/\n.scratch-*/\n.env*\n*.tsbuildinfo\n",
            )
            .unwrap();
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
        /// A group's tree, as `spawn` makes it — and with the birth claim let
        /// go, since a test retiring it is the close that comes later.
        fn group(&self, key: &str) -> String {
            let head = self.git(&["rev-parse", "HEAD"]);
            let dir = ensure_at(&self.root(), &group_branch(key), Some(&head), "test-card").unwrap().dir;
            unclaim(Path::new(&dir));
            dir
        }
        fn retire(&self, key: &str) -> Retired {
            retire(&self.root(), &group_branch(key), &|_| false)
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
        assert!(matches!(r.retire("a"), Retired::Kept(why) if why.contains("uncommitted")));
        assert!(Path::new(&tree).join("new.txt").exists());
    }

    #[test]
    fn an_unmerged_group_is_kept() {
        let r = Repo::new("unmerged");
        let tree = r.group("a");
        r.commit_in(&tree, "feature.txt");
        match r.retire("a") {
            Retired::Kept(why) => assert!(why.contains("1 commit"), "{why}"),
            other => panic!("unmerged work was not kept: {other:?}"),
        }
        assert!(Path::new(&tree).exists());
        assert!(run(&r.root(), &["rev-parse", "--verify", "refs/heads/wt/a"]).0);
    }

    #[test]
    fn a_merged_clean_group_is_taken_down_with_its_build_output() {
        let r = Repo::new("merged");
        let tree = r.group("a");
        r.commit_in(&tree, "feature.txt");
        /* What the orchestrator is told to do: rebase onto main (a no-op
           here), then fast-forward main to the group. */
        r.git(&["merge", "--ff-only", "wt/a"]);
        /* Build output: ignored, regenerable by name, and not work. */
        std::fs::create_dir_all(Path::new(&tree).join("target").join("debug")).unwrap();
        std::fs::write(Path::new(&tree).join("target").join("debug").join("big.bin"), "x").unwrap();
        std::fs::write(Path::new(&tree).join("tsconfig.tsbuildinfo"), "{}").unwrap();
        assert_eq!(r.retire("a"), Retired::Removed(None));
        assert!(!Path::new(&tree).exists());
        assert!(!run(&r.root(), &["rev-parse", "--verify", "refs/heads/wt/a"]).0);
        assert!(r.0.join("feature.txt").exists(), "the merged work is on main");
        assert!(r.git(&["worktree", "list", "--porcelain"]).lines().filter(|l| l.starts_with("worktree ")).count() == 1);
    }

    #[test]
    fn an_empty_group_is_taken_down() {
        /* Opened, nothing committed, nothing left behind: its tip is the base,
           which is on main already. */
        let r = Repo::new("empty");
        let tree = r.group("a");
        assert_eq!(r.retire("a"), Retired::Removed(None));
        assert!(!Path::new(&tree).exists());
    }

    /* ── finding 2: ignored is not disposable ──────────────────────────── */

    #[test]
    fn ignored_work_keeps_the_tree() {
        /* `.scratch-<card>/` is where CLAUDE.md sends every card's working
           files, and it is gitignored. 0.94.0 deleted it with the tree. */
        let r = Repo::new("scratch");
        let tree = r.group("a");
        let scratch = Path::new(&tree).join(".scratch-c0ffee");
        std::fs::create_dir_all(&scratch).unwrap();
        std::fs::write(scratch.join("notes.md"), "the plan").unwrap();
        match r.retire("a") {
            Retired::Kept(why) => assert!(why.contains(".scratch-c0ffee"), "{why}"),
            other => panic!("ignored work was not kept: {other:?}"),
        }
        assert!(scratch.join("notes.md").exists());
    }

    #[test]
    fn a_seeded_file_goes_only_while_it_is_the_main_trees_copy() {
        let r = Repo::new("seeded");
        std::fs::write(r.0.join(".env.local"), "KEY=1").unwrap();
        std::fs::write(r.0.join(INCLUDE_FILE), ".env*\n").unwrap();
        r.git(&["add", INCLUDE_FILE]);
        r.git(&["commit", "-q", "-m", "include"]);

        let tree = r.group("a");
        assert!(Path::new(&tree).join(".env.local").exists(), "the seed copied it");
        assert_eq!(r.retire("a"), Retired::Removed(None), "an unchanged copy is not work");

        let tree = r.group("b");
        std::fs::write(Path::new(&tree).join(".env.local"), "KEY=edited").unwrap();
        match r.retire("b") {
            Retired::Kept(why) => assert!(why.contains(".env.local"), "{why}"),
            other => panic!("an edited seed was not kept: {other:?}"),
        }
        assert_eq!(std::fs::read_to_string(Path::new(&tree).join(".env.local")).unwrap(), "KEY=edited");
    }

    /* ── finding 3: commits off the branch ─────────────────────────────── */

    #[test]
    fn a_detached_head_with_commits_keeps_the_tree() {
        /* The branch stays at its base — "merged" — while the work sits on a
           commit only the tree's own HEAD and reflog reach. */
        let r = Repo::new("detached");
        let tree = r.group("a");
        assert!(run(&tree, &["checkout", "-q", "--detach"]).0);
        r.commit_in(&tree, "lost.txt");
        let (_, sha, _) = run(&tree, &["rev-parse", "HEAD"]);
        match r.retire("a") {
            Retired::Kept(why) => assert!(why.contains("detached"), "{why}"),
            other => panic!("detached work was not kept: {other:?}"),
        }
        assert!(run(&tree, &["cat-file", "-e", &sha]).0);
        assert!(Path::new(&tree).join("lost.txt").exists());
    }

    #[test]
    fn a_bisect_in_progress_keeps_the_tree() {
        let r = Repo::new("bisect");
        let tree = r.group("a");
        assert!(run(&tree, &["bisect", "start"]).0);
        match r.retire("a") {
            Retired::Kept(why) => assert!(why.contains("bisect"), "{why}"),
            other => panic!("a bisect was not kept: {other:?}"),
        }
        assert!(Path::new(&tree).exists());
    }

    /* ── finding 1: a removal that stops short ─────────────────────────── */

    #[cfg(windows)]
    fn junction(link: &Path, target: &Path) {
        let ok = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .stdout(Stdio::null())
            .status()
            .unwrap()
            .success();
        assert!(ok, "mklink /J {} {}", link.display(), target.display());
    }

    #[cfg(windows)]
    #[test]
    fn a_node_modules_junction_is_unlinked_and_its_target_survives() {
        /* git 2.55 removes such a tree with exit 0 and leaves the folder
           holding the junction, which then reads as the main repository. */
        let r = Repo::new("junction");
        let victim = r.0.with_extension("victim");
        let _ = std::fs::remove_dir_all(&victim);
        std::fs::create_dir_all(&victim).unwrap();
        std::fs::write(victim.join("keep.txt"), "keep").unwrap();
        let tree = r.group("a");
        junction(&Path::new(&tree).join("node_modules"), &victim);
        assert_eq!(r.retire("a"), Retired::Removed(None));
        assert!(!Path::new(&tree).exists(), "the folder was left behind");
        assert!(victim.join("keep.txt").exists(), "the junction's target was touched");
        let _ = std::fs::remove_dir_all(&victim);
    }

    #[cfg(windows)]
    #[test]
    fn a_file_held_open_keeps_the_whole_tree_intact() {
        /* 0.94.0: `remove` returned 255 having already deleted the tracked
           files and the `.git` link. Now the move to a tombstone fails first,
           and nothing has been touched. */
        use std::os::windows::fs::OpenOptionsExt;
        let r = Repo::new("held");
        let tree = r.group("a");
        let lock = Path::new(&tree).join("build").join("lock.bin");
        std::fs::create_dir_all(lock.parent().unwrap()).unwrap();
        std::fs::write(&lock, "x").unwrap();
        let held = std::fs::OpenOptions::new().read(true).share_mode(0).open(&lock).unwrap();
        match r.retire("a") {
            Retired::Kept(why) => assert!(why.contains("moved aside"), "{why}"),
            other => panic!("a held tree was not kept: {other:?}"),
        }
        drop(held);
        assert!(Path::new(&tree).join("a.txt").exists(), "tracked files were deleted");
        assert!(!lost_its_link(Path::new(&tree)), "the .git link was deleted");
        assert_eq!(run(&tree, &["symbolic-ref", "HEAD"]).1, "refs/heads/wt/a");
        /* And once nothing holds it, it goes. */
        assert_eq!(r.retire("a"), Retired::Removed(None));
    }

    #[test]
    fn a_leftover_folder_is_moved_aside_never_handed_to_a_card() {
        /* What a removal that stopped short leaves: the folder, no `.git`. A
           card sent there would commit on main. */
        let r = Repo::new("leftover");
        let dir = dir_for(&r.root(), "wt/a");
        std::fs::create_dir_all(dir.join("build")).unwrap();
        std::fs::write(dir.join("build").join("lock.bin"), "x").unwrap();
        /* Compared as places, not strings: on CI %TEMP% is spelled with an 8.3
           short name (`runner~1`) and git answers with the long one
           (`runneradmin`), which failed v0.94.1's build on a true hazard. */
        let place = |p: &str| std::fs::canonicalize(p).unwrap();
        assert_eq!(
            place(&run(&dir.to_string_lossy(), &["rev-parse", "--show-toplevel"]).1),
            place(&r.root()),
            "the hazard: git inside the leftover answers the main repository"
        );
        let head = r.git(&["rev-parse", "HEAD"]);
        let e = ensure_at(&r.root(), "wt/a", Some(&head), "test-card").unwrap();
        unclaim(&dir);
        assert!(e.made);
        let aside = PathBuf::from(e.moved_aside.expect("it says it moved something"));
        assert!(aside.join("build").join("lock.bin").exists(), "nothing in it was deleted");
        assert!(!lost_its_link(&dir));
        assert_eq!(run(&e.dir, &["symbolic-ref", "HEAD"]).1, "refs/heads/wt/a");
        /* A wake finds a leftover the same way. */
        std::fs::remove_dir_all(&aside).unwrap();
    }

    #[test]
    fn a_retire_reports_a_leftover_rather_than_calling_it_kept_work() {
        let r = Repo::new("leftover-retire");
        let dir = dir_for(&r.root(), "wt/a");
        std::fs::create_dir_all(&dir).unwrap();
        assert!(matches!(r.retire("a"), Retired::Kept(why) if why.contains("not a git worktree")));
    }

    /* ── finding 4: a spawn racing a retire ────────────────────────────── */

    #[test]
    fn a_tree_being_born_into_is_not_retired() {
        let r = Repo::new("claim");
        let head = r.git(&["rev-parse", "HEAD"]);
        let dir = ensure_at(&r.root(), "wt/a", Some(&head), "born-1").unwrap().dir;
        /* `retire` hands the claimed cards to the census; a card with no row
           yet is in use, however long its front end takes. */
        let asked = std::sync::Mutex::new(Vec::new());
        let no_row_yet = |cards: &[String]| {
            *asked.lock().unwrap() = cards.to_vec();
            cards.iter().any(|c| c == "born-1")
        };
        assert_eq!(retire(&r.root(), "wt/a", &no_row_yet), Retired::Nothing);
        assert_eq!(*asked.lock().unwrap(), vec!["born-1".to_string()]);
        assert!(Path::new(&dir).exists());
        /* Once its row exists — and the card has closed — the claim is the
           census's to judge, with no clock to wait out. */
        assert_eq!(retire(&r.root(), "wt/a", &|_| false), Retired::Removed(None));
        assert!(!Path::new(&dir).exists());
    }

    #[test]
    fn a_mark_does_not_outlive_its_branch() {
        /* `branch -d` exits 0 with the ref gone and the config untouched when
           `config.lock` is held by a tree being made beside it. */
        let r = Repo::new("lockedmark");
        let tree = r.group("a");
        let lock = r.0.join(".git").join("config.lock");
        std::fs::write(&lock, "").unwrap();
        let root = r.root();
        let freer = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(300));
            let _ = std::fs::remove_file(lock);
        });
        assert_eq!(r.retire("a"), Retired::Removed(None));
        freer.join().unwrap();
        assert!(!Path::new(&tree).exists());
        assert!(!run(&root, &["rev-parse", "--verify", "--quiet", "refs/heads/wt/a"]).0);
        assert!(
            !run(&root, &["config", "--get", "branch.wt/a.voleryGroup"]).0,
            "a mark was left with no branch under it"
        );
    }

    #[test]
    fn a_wake_does_not_claim() {
        let r = Repo::new("wake");
        let tree = r.group("a");
        ensure(&r.root(), "wt/a").unwrap();
        assert_eq!(r.retire("a"), Retired::Removed(None));
        assert!(!Path::new(&tree).exists());
    }

    #[test]
    fn a_finished_tombstone_is_swept() {
        let r = Repo::new("tomb");
        let tree = r.group("a");
        let tomb = Path::new(&tree).with_file_name(".retiring-wt+a-1");
        let young = Path::new(&tree).with_file_name(format!(".retiring-wt+b-{}", unix_now()));
        std::fs::create_dir_all(&young).unwrap();
        assert!(run(&r.root(), &["worktree", "move", &tree, &tomb.to_string_lossy()]).0);
        assert!(run(&tomb.to_string_lossy(), &["checkout", "-q", "--detach"]).0);
        let (groups, tombs) = leftovers(&r.root());
        assert!(groups.is_empty());
        assert_eq!(tombs, vec![tomb.clone()], "a tombstone made a moment ago is spared");
        finish(&r.root(), &tomb).unwrap();
        assert!(!tomb.exists());
    }

    /* ── finding 5: a stale branch ─────────────────────────────────────── */

    #[test]
    fn a_merged_branch_left_behind_is_replaced_and_the_new_base_used() {
        let r = Repo::new("stale");
        let tree = r.group("a");
        /* What a removal whose `branch -d` failed left: the branch, merged,
           marked, and no tree. */
        assert!(run(&r.root(), &["worktree", "remove", &tree]).0);
        let old = r.git(&["rev-parse", "wt/a"]);
        r.commit_in(&r.root(), "scaffold.txt");
        let head = r.git(&["rev-parse", "HEAD"]);
        let e = ensure_at(&r.root(), "wt/a", Some(&head), "test-card").unwrap();
        unclaim(Path::new(&e.dir));
        assert_eq!(e.replaced.as_deref(), Some(old.as_str()));
        assert!(e.resumed.is_none());
        assert_eq!(run(&e.dir, &["rev-parse", "HEAD"]).1, head, "the group started where it was asked to");
        assert!(Path::new(&e.dir).join("scaffold.txt").exists());
        assert!(marked_by_us(&r.root(), "wt/a"));
    }

    #[test]
    fn an_unmerged_or_foreign_branch_is_resumed_and_says_so() {
        let r = Repo::new("resume");
        r.git(&["branch", "wt/a"]);
        /* A person's `wt/a` with a commit on it, no mark. */
        r.git(&["checkout", "-q", "wt/a"]);
        r.commit_in(&r.root(), "theirs.txt");
        let tip = r.git(&["rev-parse", "HEAD"]);
        r.git(&["checkout", "-q", "main"]);
        let head = r.git(&["rev-parse", "HEAD"]);
        let e = ensure_at(&r.root(), "wt/a", Some(&head), "test-card").unwrap();
        unclaim(Path::new(&e.dir));
        assert_eq!(e.resumed.as_deref(), Some(tip.as_str()));
        assert!(Path::new(&e.dir).join("theirs.txt").exists());
        assert!(!marked_by_us(&r.root(), "wt/a"), "a resumed branch is not claimed as a group");
        /* And so it is never taken down by the wall. */
        assert!(matches!(r.retire("a"), Retired::Kept(why) if why.contains("not marked")));
        assert!(Path::new(&e.dir).exists());
    }

    #[test]
    fn a_group_merged_into_the_remote_goes_even_with_the_main_tree_elsewhere() {
        /* `branch -d` judges against the main tree's HEAD alone (the branch has
           no upstream), so with the main tree on another branch it refused —
           and 0.94.0 swallowed the refusal. */
        let r = Repo::new("remote");
        let origin = r.0.with_extension("origin");
        let _ = std::fs::remove_dir_all(&origin);
        assert!(run(&r.root(), &["clone", "-q", "--bare", &r.root(), &origin.to_string_lossy()]).0);
        r.git(&["remote", "add", "origin", &origin.to_string_lossy()]);
        r.git(&["fetch", "-q", "origin"]);
        let tree = r.group("a");
        r.commit_in(&tree, "feature.txt");
        r.git(&["merge", "-q", "--ff-only", "wt/a"]);
        r.git(&["push", "-q", "origin", "main"]);
        r.git(&["checkout", "-q", "-b", "side", "HEAD~1"]);
        assert_eq!(r.retire("a"), Retired::Removed(None));
        assert!(!run(&r.root(), &["rev-parse", "--verify", "refs/heads/wt/a"]).0, "the branch was left");
        let _ = std::fs::remove_dir_all(&origin);
    }

    /* ── the red-team review of the fixes (2026-11-02) ──────────────────── */

    #[test]
    fn a_group_branch_the_main_tree_stands_on_is_never_deleted_by_a_birth() {
        /* Reproduced by the review: `HEAD` *is* the tip, so the tip was
           "merged", `update-ref -d` deleted a checked-out branch, and the work
           commit was left reachable from a reflog alone. */
        let r = Repo::new("onit");
        let tree = r.group("x");
        r.commit_in(&tree, "work.txt");
        let work = r.git(&["rev-parse", "wt/x"]);
        assert!(run(&r.root(), &["worktree", "remove", &tree]).0);
        r.git(&["checkout", "-q", "wt/x"]);
        let main = r.git(&["rev-parse", "main"]);
        let made = ensure_at(&r.root(), "wt/x", Some(&main), "test-card");
        unclaim(&dir_for(&r.root(), "wt/x"));
        assert!(made.is_err(), "a tree was made for a branch the main tree has checked out");
        assert_eq!(r.git(&["rev-parse", "wt/x"]), work, "the branch was moved or deleted");
        assert_eq!(r.git(&["symbolic-ref", "HEAD"]), "refs/heads/wt/x");
        assert!(marked_by_us(&r.root(), "wt/x"), "the mark went");
    }

    #[test]
    fn a_detached_main_tree_is_no_branch_to_be_merged_into() {
        /* A paused `git rebase wt/x` in the main tree, a bisect, or a look
           with `switch --detach wt/x`: the group's tip is an ancestor of HEAD
           and of nothing that will outlive HEAD moving. */
        let r = Repo::new("mainloose");
        let tree = r.group("x");
        r.commit_in(&tree, "work.txt");
        r.git(&["switch", "-q", "--detach", "wt/x"]);
        assert!(matches!(r.retire("x"), Retired::Kept(why) if why.contains("not on the main tree")));
        assert!(Path::new(&tree).join("work.txt").exists());
        assert!(run(&r.root(), &["rev-parse", "--verify", "refs/heads/wt/x"]).0);
    }

    #[test]
    fn an_ignored_file_in_a_tracked_folder_named_like_output_is_still_a_file() {
        let r = Repo::new("trackedbuild");
        std::fs::write(r.0.join(".gitignore"), "*.env\n").unwrap();
        std::fs::create_dir_all(r.0.join("build")).unwrap();
        std::fs::write(r.0.join("build").join("script.sh"), "echo\n").unwrap();
        r.git(&["add", "."]);
        r.git(&["commit", "-q", "-m", "tracked build/"]);
        let tree = r.group("a");
        std::fs::write(Path::new(&tree).join("build").join("secret.env"), "KEY=mine").unwrap();
        match r.retire("a") {
            Retired::Kept(why) => assert!(why.contains("build/secret.env"), "{why}"),
            other => panic!("an ignored file in a tracked build/ was taken: {other:?}"),
        }
        assert!(Path::new(&tree).join("build").join("secret.env").exists());
    }

    #[test]
    fn a_card_from_before_groups_still_wakes_into_its_own_tree() {
        /* `reserved` is a birth rule. A row that already names `wt/Spike`
           must come back to it, not be refused for ever. */
        let r = Repo::new("spike");
        let dir = dir_for(&r.root(), "wt/Spike");
        r.git(&["worktree", "add", "-q", "-b", "wt/Spike", &dir.to_string_lossy()]);
        assert_eq!(ensure(&r.root(), "wt/Spike").unwrap(), dir.to_string_lossy());
        assert!(ensure_at(&r.root(), "wt/Other", None, "test-card").is_err(), "a birth is still held to it");
    }

    #[test]
    fn a_group_folder_holding_another_branch_is_not_joined() {
        /* A person's branch `wt+auth` slugs to the group `auth`'s folder. */
        let r = Repo::new("lookalike");
        let dir = dir_for(&r.root(), "wt/auth");
        r.git(&["worktree", "add", "-q", "-b", "wt+auth", &dir.to_string_lossy()]);
        let joined = ensure_at(&r.root(), "wt/auth", None, "test-card");
        unclaim(&dir);
        assert!(matches!(joined, Err(why) if why.contains("somebody else's tree")));
    }

    #[test]
    fn two_trees_are_made_at_once_and_each_is_marked() {
        /* One lock per tree: neither waits for the other, and `mark` survives
           the two of them reaching `config.lock` together. */
        let r = Repo::new("parallel");
        let head = r.git(&["rev-parse", "HEAD"]);
        let root = r.root();
        let threads: Vec<_> = ["p", "q", "s", "t"]
            .iter()
            .map(|k| {
                let (root, head) = (root.clone(), head.clone());
                std::thread::spawn(move || ensure_at(&root, &group_branch(k), Some(&head), "test-card").map(|e| e.dir))
            })
            .collect();
        for t in threads {
            let dir = t.join().unwrap().unwrap();
            unclaim(Path::new(&dir));
        }
        for k in ["p", "q", "s", "t"] {
            assert!(marked_by_us(&root, &group_branch(k)), "{k} was not marked");
        }
    }

    /* ── finding 7: whose group ────────────────────────────────────────── */

    #[test]
    fn a_wt_branch_the_wall_did_not_mark_is_never_retired() {
        let r = Repo::new("unmarked");
        let tree = r.group("a");
        r.git(&["config", "--unset", "branch.wt/a.voleryGroup"]);
        assert!(matches!(r.retire("a"), Retired::Kept(why) if why.contains("not marked")));
        assert!(Path::new(&tree).exists());
        /* Another wall's mark is not ours either. */
        r.git(&["config", "branch.wt/a.voleryGroup", "dev.skein.lab-other"]);
        assert!(matches!(r.retire("a"), Retired::Kept(_)));
        assert!(Path::new(&tree).exists());
    }

    #[test]
    fn a_name_that_folds_onto_a_group_folder_is_refused() {
        for bad in ["WT/Auth", "wt+auth", "Wt/auth", "wt/Auth", "wt/a/b"] {
            assert!(reserved(bad).is_err(), "{bad:?} was allowed");
        }
        for ok in ["wt/auth", "feat/x", "wtf/x", "main"] {
            assert!(reserved(ok).is_ok(), "{ok:?} was refused");
        }
    }

    /* ── finding 6: the seed ───────────────────────────────────────────── */

    #[test]
    fn a_seed_of_everything_never_copies_a_tree_into_itself() {
        let r = Repo::new("star");
        std::fs::write(r.0.join(".gitignore"), "*\n").unwrap();
        std::fs::write(r.0.join(INCLUDE_FILE), "*\n.claude/\n.claude/worktrees\n").unwrap();
        std::fs::write(r.0.join("local.db"), "rows").unwrap();
        r.git(&["add", "-f", ".gitignore", INCLUDE_FILE]);
        r.git(&["commit", "-q", "-m", "everything"]);
        /* A first tree, so `.claude/worktrees` is not empty when the second is
           seeded — the recursion needs one to walk into. */
        let first = r.group("first");
        let second = r.group("second");
        assert!(Path::new(&second).join("local.db").exists());
        assert!(!Path::new(&second).join(".claude").join("worktrees").exists());
        assert!(!Path::new(&second).join(".git").is_dir(), "git's own directory was copied");
        let _ = first;
    }

    #[cfg(windows)]
    #[test]
    fn a_seed_skips_a_junction_rather_than_following_it() {
        let r = Repo::new("seedloop");
        let rt = r.0.join("runtime");
        std::fs::create_dir_all(&rt).unwrap();
        std::fs::write(rt.join("a.dll"), "dll").unwrap();
        /* A junction back up to the root: followed, it never ends. */
        junction(&rt.join("loop"), &r.0);
        std::fs::write(r.0.join(".gitignore"), "runtime/\n").unwrap();
        std::fs::write(r.0.join(INCLUDE_FILE), "runtime/\n").unwrap();
        r.git(&["add", ".gitignore", INCLUDE_FILE]);
        r.git(&["commit", "-q", "-m", "include"]);
        let tree = r.group("a");
        assert!(Path::new(&tree).join("runtime").join("a.dll").exists());
        assert!(std::fs::symlink_metadata(Path::new(&tree).join("runtime").join("loop")).is_err());
        let _ = std::fs::remove_dir(rt.join("loop"));
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
        let tree = ensure_at(&r.root(), "feat/x", Some("HEAD"), "test-card").unwrap().dir;
        assert_eq!(retire(&r.root(), "feat/x", &|_| false), Retired::Nothing);
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
