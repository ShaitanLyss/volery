/*! Deleting a path from a card, behind the user's own click.
 *
 * `mcp__skein__remove` takes a path and a reason, says everything it can find
 * out about what is there, and waits for a person. Nothing here auto-approves
 * and nothing here is undoable — see `.claude/rules/remove.md` for the whole
 * argument, and the header below for the two facts it turns on.
 *
 * ## Why a tool rather than a permission
 *
 * The user's own `~/.claude/settings.json` denies `Bash(rm -rf:*)`, deliberately
 * and on a stated intent: *cards must not be able to delete without my
 * approval*. A permission rule can express the first half of that and not the
 * second — it can refuse, and it cannot ask. So a card that legitimately needs a
 * corrupt build cache gone is stopped with nowhere to go, and the thing it
 * actually does next is find a spelling that is not denied. Sink `14f2543e`
 * records the one that was reached for: `mv .next .next-stale-audit-backup`,
 * which has the same effect, is less legible about intent, and leaves five
 * gigabytes of orphaned junk on a disk nobody will ever sweep.
 *
 * **An MCP tool call is not the Bash tool, so `Bash(rm -rf:*)` never matches
 * one.** That is the entire mechanism, and it is worth being plain that the
 * bypass *is* the design rather than an awkwardness in it: the deny stays and
 * goes on blocking the unapproved shell route; this is the approved one, and the
 * only reason it can exist is that a tool can put a question in front of a
 * person and a shell command cannot.
 *
 * `.claude/rules/asana.md` reached the same conclusion one realm over and it is
 * cited rather than re-derived: *every write asks because the confirmation
 * stands in for a scope an unscoped token cannot have.* Here the scope that does
 * not exist is "this particular path, this once" — no permission vocabulary on
 * this machine can say it, so a person says it instead.
 *
 * ## Everything asks, and the tiering is deliberately not built
 *
 * `docs/TOOL-SURFACE.md` §2 works out a four-tier classification — regenerable
 * build output, ignored-but-irreplaceable, tracked-and-clean, tracked-and-dirty
 * — and recommends letting tier 1 through without a click. That is not built,
 * and the reason is the direction the mistake falls in: *"it is only a build
 * cache"* is exactly the judgement an agent gets wrong, and a `remove` that
 * always asks fails by wasting a click where one that sometimes does not fails
 * by deleting something that could not be got back. The tiers are still the
 * right analysis and the file is still worth reading; what is deferred is
 * spending them.
 *
 * ## What the confirmation has to carry
 *
 * A path on its own is not a decision. Sink `394430bf` is specific about the
 * five things it wanted, and every one of them is something the user cannot work
 * out from the string in front of them: the absolute path, whether git tracks
 * it, its size and file count, whether another card on this wall has been in it,
 * and whether a dev server is running out of it. The last is the sharpest and
 * the reason the item exists — `.next` at 5.3 GB and 9,627 files is pure build
 * cache and deleting it costs *every other card on the wall* a cold recompile,
 * which is a fact about other people's afternoon that is nowhere in the path.
 */

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tauri::Manager;

/// The name this server advertises. **Bare**, as every other tool here is: the
/// CLI prefixes each MCP tool with its server, so what a card calls is
/// `mcp__skein__remove` and what arrives in `params.name` is this. Spelling the
/// prefix in here would make the dispatch arm match nothing at all, and the
/// failure is silent — the tool lists, the schema is right, and no call ever
/// reaches it. `classify.ts` holds the prefixed form, which is what a transcript
/// carries.
pub const REMOVE_TOOL: &str = "remove";

/// The most paths one call may name.
///
/// Not a resource bound — a survey is cheap and the walk is capped below. It is
/// about the question: a confirmation listing twenty directories is one nobody
/// reads to the end, and an unread confirmation is the failure this whole module
/// exists to avoid.
const MAX_PATHS: usize = 8;

/// How far the size walk goes before it stops counting and says so.
///
/// `.next` is ~9,600 files, so the cap is more than an order of magnitude clear
/// of the case this was designed against. What it guards is the pathological
/// one — a `node_modules` at the top of a monorepo — where the honest reading is
/// *at least this many* rather than a question that never appears.
const WALK_ENTRIES: usize = 200_000;

/// And a wall-clock bound, because entries are not the only way to be slow: a
/// tree on a network share answers each `read_dir` in milliseconds rather than
/// microseconds and would blow the deadline long before the count.
const WALK_TIME: Duration = Duration::from_secs(15);

/* ── the shape a call turns into ──────────────────────────────────────────*/

/// What a `remove` call turns out to be. `docket::Writing`'s shape, for the same
/// reason it has one — and the same contract: every refusal and every argument
/// problem is a `Now`, so nothing reaches a person until the call is well-formed
/// enough to be worth their attention.
pub(crate) enum Writing {
    Now(String),
    Ask {
        question: Value,
        settle: crate::ask::Settle,
    },
}

/// The exact words a click sends.
///
/// **Its own words rather than `docket`'s `do it` reused**, and that is the same
/// argument `HAND_IT_OVER` makes over there: the panel has a free-text field
/// beside its buttons, so what comes back is arbitrary prose, and a button
/// reading *do it* under a question about deleting five gigabytes is the one
/// place a habit could carry somebody through. The verb is in the label.
const DELETE_IT: &str = "delete it";
const KEEP_IT: &str = "keep it";

/// Only the label is a yes.
///
/// `docket::approved`'s rule, and it is the whole of the gate: reading a yes out
/// of prose works right up until *"yes, but not the node_modules one"*.
pub(crate) fn approved(answer: &str) -> bool {
    answer.trim().eq_ignore_ascii_case(DELETE_IT)
}

/// What the caller is told when nobody answers.
pub(crate) fn unanswered() -> String {
    "nobody answered, so nothing was deleted. Either the question stood until it expired or \
     the card was dismissed while it was up. Carry on with your own judgement, say that you \
     offered, and do not simply try again."
        .to_string()
}

/// And when they say no, or say something else.
pub(crate) fn declined(answer: &str) -> String {
    let said = answer.trim();
    if said.eq_ignore_ascii_case(KEEP_IT) {
        return "the user was asked and said no, so nothing was deleted. That is an answer \
                rather than this tool refusing you — do not ask again about the same path, do \
                not look for another way to remove it, and say in your reply that you offered."
            .to_string();
    }
    format!(
        "the user was asked and pressed neither button. They said: {said:?}. Nothing was \
         deleted. Act on what they actually said."
    )
}

/* ── paths, compared the way this filesystem compares them ────────────────*/

/// One path in the one spelling everything here compares on.
///
/// Separators folded to `/` and the whole thing lowercased, because this is a
/// Windows-first app and `C:\Users\…\Skein` and `c:/users/…/skein` are the same
/// directory. Nothing is drawn from this — the *displayed* path is always the
/// canonical one, since a lowercased path in a confirmation reads as a different
/// place from the one the card named.
pub(crate) fn key(p: &str) -> String {
    p.replace('\\', "/")
        .trim_end_matches('/')
        .to_ascii_lowercase()
}

/// Are these the same path?
pub(crate) fn same(a: &str, b: &str) -> bool {
    key(a) == key(b)
}

/// Is `child` inside `parent`, or `parent` itself?
///
/// **On segment boundaries, which is the half that is easy to get wrong.** A
/// plain `starts_with` says `C:/work/skein-old` is inside `C:/work/skein`, and
/// this function decides whether a delete is refused — so the wrong answer in
/// that direction is a refusal that cannot be argued with, and in the other
/// direction it is a territory root deleted because its name was a prefix of
/// something else.
pub(crate) fn under(parent: &str, child: &str) -> bool {
    let (p, c) = (key(parent), key(child));
    if p == c {
        return true;
    }
    c.starts_with(&p) && c.as_bytes().get(p.len()) == Some(&b'/')
}

/// Has this path a `.git` anywhere in it?
///
/// Named rather than resolved: `.git` is a *file* in a worktree rather than a
/// directory, so asking the filesystem what it is would answer differently in
/// the two places it matters and both answers are "leave it alone".
pub(crate) fn touches_git_dir(p: &str) -> bool {
    key(p).split('/').any(|seg| seg == ".git")
}

/// Is this the root of a filesystem — `C:/`, `/`, or a bare UNC share?
///
/// `Path::parent` answers this for the ordinary cases. The UNC arm is by hand
/// because `\\server\share` has a parent (`\\server`) as far as Rust is
/// concerned, and deleting a whole share is not a thing to find out about from
/// the absence of a check.
pub(crate) fn is_root(p: &str) -> bool {
    let k = key(p);
    if let Some(rest) = k.strip_prefix("//") {
        return rest.split('/').filter(|s| !s.is_empty()).count() <= 2;
    }
    Path::new(&k).parent().is_none() || k.is_empty()
}

/* ── what was found out before anybody was asked ──────────────────────────*/

/// Everything gathered about one target, before the question is composed.
///
/// **Gathered before rather than after**, which is `docket`'s rule stated one
/// module over and for a sharper reason: a confirmation that says *"delete a
/// directory"* without saying how big it is or who else is in it is not a
/// smaller version of this question, it is a different and worthless one. The
/// walk is what costs; see `WALK_ENTRIES` for what bounds it.
#[derive(Debug, Clone, Default)]
pub(crate) struct Survey {
    /// Absolute and canonical, as it will be handed to the filesystem and as it
    /// is drawn in the question.
    pub(crate) path: String,
    pub(crate) exists: bool,
    pub(crate) is_dir: bool,
    /// The root of the git work tree this sits in, if any.
    pub(crate) repo_root: Option<String>,
    /// How many files under it git has in its index.
    pub(crate) tracked: usize,
    /// Tracked files under it carrying uncommitted changes, as git names them.
    /// A non-empty list is a refusal, whoever the changes belong to.
    pub(crate) dirty: Vec<String>,
    pub(crate) bytes: u64,
    pub(crate) files: usize,
    /// The walk hit `WALK_ENTRIES` or `WALK_TIME`, so `bytes` and `files` are
    /// floors rather than counts and the question says so.
    pub(crate) capped: bool,
    /// Other cards on this wall that have *written* to something under it.
    pub(crate) writers: Vec<String>,
    /// Dev server groups currently up in a territory that contains it.
    pub(crate) servers: Vec<String>,
}

/// Where the caller is standing, and what the wall says is off limits.
#[derive(Debug, Clone, Default)]
pub(crate) struct Ground {
    /// The directory the card's own process runs in.
    pub(crate) cwd: String,
    /// Every territory root on the wall.
    pub(crate) roots: Vec<String>,
    /// The user's home directory.
    pub(crate) home: String,
}

/// Should this be refused outright, whatever anybody would click?
///
/// Pure, and that is deliberate: this is the function that decides whether a
/// delete is possible at all, and on a machine with no MSVC toolchain a
/// `#[test]` it cannot run is a `#[test]` that proves nothing. `tools/lift-remove.ts`
/// runs these. See `.claude/rules/build.md`.
///
/// **Refusing is cheap and a refusal is legible**, so this errs towards it. Each
/// arm names what to do instead, because a refusal an agent cannot act on is one
/// it will work around.
pub(crate) fn refuse(s: &Survey, g: &Ground) -> Option<String> {
    let p = &s.path;

    if !s.exists {
        return Some(format!(
            "{p} does not exist, so nothing was deleted and nobody was asked. Say so rather \
             than treating this as done — a path that is already gone and a path you got \
             wrong look identical from here, and only one of them means your next step is \
             right."
        ));
    }

    if touches_git_dir(p) {
        return Some(format!(
            "{p} is inside a `.git` directory. That is the repository itself — its objects, \
             its refs, its reflog — and losing it loses every branch nobody has pushed. There \
             is no version of this worth asking about. If a git operation has wedged, say so \
             and let the user run it."
        ));
    }

    if is_root(p) {
        return Some(format!("{p} is a filesystem root. No."));
    }

    if same(p, &g.home) {
        return Some(format!("{p} is the user's home directory. No."));
    }

    /* An *ancestor* of where the card stands, which is the form
       `docs/TOOL-SURFACE.md` names. A sibling is not refused here — it is
       surveyed and asked about like anything else, since a card in one territory
       clearing another's build cache is a real and reasonable thing to want. */
    if under(p, &g.cwd) {
        return Some(format!(
            "{p} contains the directory this card is running in ({}), so deleting it would \
             take the ground out from under the turn that asked. Name something inside your \
             own tree instead.",
            g.cwd
        ));
    }

    if let Some(root) = &s.repo_root {
        if same(p, root) {
            return Some(format!(
                "{p} is the root of a git work tree. A repository is not a thing to remove by \
                 the path — it is other cards' checkout as well as yours, and every branch \
                 nobody has pushed lives in it. Name what inside it you actually want gone."
            ));
        }
    }

    if let Some(hit) = g.roots.iter().find(|r| same(p, r)) {
        return Some(format!(
            "{p} is a territory root on this wall ({hit}). Every card standing there would \
             lose its working directory. Name something inside it."
        ));
    }

    if !s.dirty.is_empty() {
        /* **The dirty half is frequently somebody else's**, and that is sink
           `8404a6ca`'s lesson arriving in a new realm: several cards share this
           working tree, so "uncommitted" here does not mean "mine". A card that
           knows its own edits are disposable knows nothing at all about the
           three sitting beside it, and a delete is the one gesture that takes
           them all at once with nothing anywhere to say so. */
        let shown: Vec<&str> = s.dirty.iter().take(6).map(String::as_str).collect();
        let more = s.dirty.len().saturating_sub(shown.len());
        return Some(format!(
            "{p} is inside a git work tree and holds uncommitted changes to {} tracked \
             file{}, so nothing was deleted and nobody was asked:\n\n{}{}\n\n\
             **In a tree this wall shares, those changes are frequently not yours.** Several \
             cards work in one checkout here, so uncommitted work under a path you are about \
             to remove may belong to a card that has not written it down yet, and a delete \
             takes all of it at once with nothing to say whose it was. `mcp__skein__touched` \
             says who has been in these files and costs nobody a turn.\n\n\
             What to do instead: commit or discard the changes first if they are yours, or \
             name a path that does not contain them.",
            s.dirty.len(),
            if s.dirty.len() == 1 { "" } else { "s" },
            shown
                .iter()
                .map(|f| format!("  {f}\n"))
                .collect::<String>(),
            if more > 0 {
                format!("  … and {more} more")
            } else {
                String::new()
            },
        ));
    }

    None
}

/* ── the reading a person is given ────────────────────────────────────────*/

/// Bytes, in the register a person judges a delete in.
///
/// Two significant figures past a kilobyte, because the decision this informs is
/// *"is this the five-gigabyte one"* and not *"is it 5.34 or 5.35"*.
pub(crate) fn human_size(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut n = bytes as f64;
    let mut u = 0;
    while n >= 1024.0 && u < UNITS.len() - 1 {
        n /= 1024.0;
        u += 1;
    }
    if u == 0 {
        format!("{bytes} B")
    } else if n >= 100.0 {
        format!("{n:.0} {}", UNITS[u])
    } else {
        format!("{n:.1} {}", UNITS[u])
    }
}

/// One target's line in the question.
///
/// Every clause here is something the user cannot get from the path, which is
/// the test sink `394430bf` set for this and the reason the tool beats a card
/// asking in prose.
pub(crate) fn describe(s: &Survey) -> String {
    let mut out = format!("**{}**\n", s.path);

    let what = if s.is_dir { "directory" } else { "file" };
    let size = if s.capped {
        format!(
            "more than {} in more than {} files",
            human_size(s.bytes),
            s.files
        )
    } else if s.is_dir {
        format!("{} in {} file{}", human_size(s.bytes), s.files, if s.files == 1 { "" } else { "s" })
    } else {
        human_size(s.bytes)
    };
    out.push_str(&format!("- {what}, {size}\n"));

    out.push_str(&match (&s.repo_root, s.tracked) {
        (None, _) => "- not in a git work tree — nothing here comes back from a commit\n".to_string(),
        (Some(_), 0) => {
            "- in a git work tree but **untracked** — git has no copy of any of it, so \
             nothing here comes back from a commit\n"
                .to_string()
        }
        (Some(_), n) => format!(
            "- git tracks {n} file{} under it, so those come back from a commit\n",
            if n == 1 { "" } else { "s" }
        ),
    });

    if !s.writers.is_empty() {
        out.push_str(&format!(
            "- **{} other card{} on this wall {} written in here**: {}\n",
            s.writers.len(),
            if s.writers.len() == 1 { "" } else { "s" },
            if s.writers.len() == 1 { "has" } else { "have" },
            s.writers.join(", ")
        ));
    }

    if !s.servers.is_empty() {
        out.push_str(&format!(
            "- **a dev server is running out of this tree right now**: {}. Deleting a build \
             cache under a live server costs every card on this wall a cold recompile.\n",
            s.servers.join(", ")
        ));
    }

    out
}

/// The question, for however many paths one call named.
///
/// One question rather than one per path: a call is one park and therefore one
/// reply (`ask.rs`), and — the half that matters more — a card naming three
/// directories is making one decision about clearing them, not three.
pub(crate) fn question(reason: &str, surveys: &[Survey]) -> Value {
    let header = if surveys.len() == 1 {
        "delete a path".to_string()
    } else {
        format!("delete {} paths", surveys.len())
    };

    let mut body = format!("A card wants to **delete** {}:\n\n", if surveys.len() == 1 { "this" } else { "these" });
    for s in surveys {
        body.push_str(&describe(s));
        body.push('\n');
    }
    body.push_str(&format!("Its reason: *{}*\n\n", reason.trim()));

    /* **The one sentence that is not a reading**, and it is the sentence the
       whole design rests on. `.claude/rules/remove.md` argues why the delete is
       permanent rather than a recycle-bin move; what matters here is that the
       question says so, because a confirmation that lets somebody believe there
       is a way back is worse than no confirmation at all. */
    body.push_str(
        "**This is permanent.** It is not moved to the recycle bin and Ctrl+Z does not reach \
         it — the recycle bin silently skips anything over its per-volume quota, so a \
         promise of recovery here would be one that quietly does not hold for exactly the \
         large directories worth asking about.",
    );

    json!({
        "questions": [{
            "header": header,
            "question": body,
            "options": [
                { "label": DELETE_IT, "detail": "Gone for good. The agent is told what was removed." },
                { "label": KEEP_IT, "detail": "Nothing is touched. The agent is told you said so." }
            ]
        }]
    })
}

/* ── the schema ───────────────────────────────────────────────────────────*/

/// What a card reads before it calls this.
///
/// **The opening line is the tool**, not documentation of it. `pull_request`'s
/// description sets the form and the reason is the same one: the failure this
/// exists to prevent is a card reaching for a shell delete out of habit, and the
/// only sentence that helps is one naming the habit it replaces. Sink
/// `d3a1921a` is the record of even that not always being enough, which is why
/// `hooks.rs` carries the other half — a deny whose reason arrives at the moment
/// the reflex fires, which is the one thing no description can do.
pub fn remove_schema() -> Value {
    json!({
        "name": REMOVE_TOOL,
        "description":
            "Delete a file or directory from this machine, behind the user's own click. \
             **Use this instead of `rm -rf`**, which is denied on this machine and which you \
             should not go looking for a spelling around — `mv`-ing a directory aside, \
             `Remove-Item -Recurse -Force` and `find … -delete` all have the same effect and \
             are the same act with the intent taken out of it.\n\n\
             **Every call asks, and the asking is the point.** A path is put in front of the \
             user with everything they cannot see from the path itself: how big it is and how \
             many files, whether git tracks it, whether another card on this wall has been \
             writing in it, and whether a dev server is running out of that tree. Then they \
             press a button. There is no self-serve tier and no 'it's only a build cache' \
             — say what you want gone and let them decide.\n\n\
             **It is permanent.** Nothing goes to the recycle bin, nothing is undoable, and \
             the confirmation says so. Treat a yes as final.\n\n\
             Refused outright, with a click or without one: a path holding uncommitted \
             changes to tracked files — in a tree this wall shares those are frequently \
             *another card's* unwritten work — anything under `.git`, a git work tree's root, \
             a territory root, a filesystem root, and any directory this card is standing \
             inside. A path that does not exist is reported as not existing rather than \
             quietly succeeding.\n\n\
             The ordinary case is a corrupt or stale build cache — `.next`, `dist`, `target`, \
             `.turbo`, `node_modules` — where the tree is regenerable and the cost is a \
             recompile. Say that in `reason`: it is the sentence the user is actually \
             deciding on, and 'clearing a corrupt Turbopack manifest so the dev server can \
             restart' is a decision where 'cleanup' is not.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "paths": {
                    "anyOf": [
                        { "type": "string" },
                        { "type": "array", "items": { "type": "string" } }
                    ],
                    "description":
                        "What to delete. Absolute, or relative to this card's working \
                         directory. Several may be named and they are decided together as one \
                         question — so name the ones that go together and not everything you \
                         might ever want gone."
                },
                "reason": {
                    "type": "string",
                    "description":
                        "Why it needs to go, in a line, written for the person deciding. What \
                         is broken and what removing it unblocks — not 'cleanup', which tells \
                         them nothing they can weigh."
                }
            },
            "required": ["paths", "reason"]
        }
    })
}

/* ── reading the arguments ────────────────────────────────────────────────*/

/// `paths` as one or many, in the order given, without duplicates.
///
/// Degrades rather than refusing on shape, the same bargain `asking.ts` strikes:
/// the payload is whatever a model composed. What it will not do is silently
/// drop a path — anything that is not a usable string leaves the list short, and
/// the count is checked against what was asked for before anybody is shown
/// anything.
pub(crate) fn paths_from(args: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |s: &str| {
        let t = s.trim();
        if !t.is_empty() && !out.iter().any(|p| same(p, t)) {
            out.push(t.to_string());
        }
    };
    match args.get("paths") {
        Some(Value::String(s)) => push(s),
        Some(Value::Array(a)) => {
            for v in a {
                if let Some(s) = v.as_str() {
                    push(s);
                }
            }
        }
        _ => {}
    }
    out
}

/* ── going and looking ────────────────────────────────────────────────────*/

/// Ask git something, quietly, and never let it ask anything back.
///
/// The three environment variables are `hooks::git`'s and the reasoning is its,
/// restated here because it matters at least as much: `GIT_OPTIONAL_LOCKS=0`
/// stops `status` opportunistically refreshing and *rewriting* the index — in a
/// tree where several cards are running git at once. A guard against a shared
/// index must not become another writer to it. Deliberately not shared with that
/// module, which is reachable from `main` before anything is set up and pays for
/// its own copy on every shell command every card runs.
fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let mut cmd = std::process::Command::new("git");
    cmd.current_dir(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_CONFIG_PARAMETERS", "'credential.interactive=false'")
        .stdin(std::process::Stdio::null());
    let out = quiet(&mut cmd).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

#[cfg(windows)]
fn quiet(cmd: &mut std::process::Command) -> &mut std::process::Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW)
}
#[cfg(not(windows))]
fn quiet(cmd: &mut std::process::Command) -> &mut std::process::Command {
    cmd
}

/// Size and file count, bounded two ways.
///
/// Iterative rather than recursive: the depth of a `node_modules` is whatever
/// npm felt like, and a stack overflow inside a survey would take the whole
/// request thread with it.
fn weigh(root: &Path) -> (u64, usize, bool) {
    let started = Instant::now();
    let mut bytes = 0u64;
    let mut files = 0usize;
    let mut seen = 0usize;
    let mut stack = vec![root.to_path_buf()];

    while let Some(dir) = stack.pop() {
        if seen >= WALK_ENTRIES || started.elapsed() >= WALK_TIME {
            return (bytes, files, true);
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in entries.flatten() {
            seen += 1;
            if seen >= WALK_ENTRIES || started.elapsed() >= WALK_TIME {
                return (bytes, files, true);
            }
            /* `DirEntry::metadata` and not `fs::metadata`, which are not the
               same function: this one does **not** traverse a symlink, so a
               junction into somebody else's tree is counted as the link it is
               rather than walked into. Windows build tooling makes these
               constantly, and following one would both inflate the reading and
               — far worse — make the question describe a tree the delete is not
               going to touch. */
            let Ok(md) = e.metadata() else {
                continue;
            };
            if md.is_dir() {
                stack.push(e.path());
            } else {
                bytes += md.len();
                files += 1;
            }
        }
    }
    (bytes, files, false)
}

/// Everything about one path, gathered before the question.
fn survey(app: &AppHandle, caller: &str, abs: &Path) -> Survey {
    let path = abs.to_string_lossy().to_string();
    let md = std::fs::symlink_metadata(abs).ok();
    let mut s = Survey {
        path: path.clone(),
        exists: md.is_some(),
        is_dir: md.as_ref().is_some_and(|m| m.is_dir()),
        ..Default::default()
    };
    if !s.exists {
        return s;
    }

    if s.is_dir {
        let (bytes, files, capped) = weigh(abs);
        s.bytes = bytes;
        s.files = files;
        s.capped = capped;
    } else {
        s.bytes = md.as_ref().map(|m| m.len()).unwrap_or(0);
        s.files = 1;
    }

    /* git is asked from the containing directory, never from the target: a
       target that is a file has no directory to run in, and one that is a
       directory is about to be deleted, so standing in it is a handle on the
       thing being removed. */
    let ask_from = if s.is_dir { abs } else { abs.parent().unwrap_or(abs) };
    if let Some(top) = git(ask_from, &["rev-parse", "--show-toplevel"]) {
        let root = top.trim().to_string();
        if !root.is_empty() {
            s.repo_root = Some(root.replace('/', std::path::MAIN_SEPARATOR_STR));
        }
    }
    if s.repo_root.is_some() {
        s.tracked = git(ask_from, &["ls-files", "--", &path])
            .map(|o| o.lines().filter(|l| !l.trim().is_empty()).count())
            .unwrap_or(0);
        /* `--untracked-files=no` on purpose: an untracked file under a build
           cache is the normal state of a build cache, and refusing on one would
           make the tool refuse every case it was built for. What is being asked
           is whether git holds a version of something that is about to differ
           from what is on disk — which is exactly the tracked half. */
        s.dirty = git(
            ask_from,
            &["status", "--porcelain", "--untracked-files=no", "--", &path],
        )
        .map(|o| {
            o.lines()
                .filter(|l| l.len() > 3)
                .map(|l| l[3..].trim().to_string())
                .collect()
        })
        .unwrap_or_default();
    }

    s.writers = other_writers(app, caller, &path);
    s.servers = servers_over(app, &path);
    s
}

/// Which other cards on this wall have *written* under this path.
///
/// `store::touches_near` is the wall's own record and is asked rather than git,
/// which is `394430bf`'s instruction and the better answer besides: git knows
/// what changed and not who changed it, and a card that wrote a file and then
/// reverted it is still a card that was working here.
fn other_writers(app: &AppHandle, caller: &str, path: &str) -> Vec<String> {
    let Some(store) = app.try_state::<crate::store::Store>() else {
        return Vec::new();
    };
    let Ok(conn) = store.0.lock() else {
        return Vec::new();
    };
    /* The needle is the last segment, since `touches_near` matches a substring
       and a whole absolute path would miss every row recorded under a different
       spelling of the same place. The rows are then filtered on the real
       containment test, so the loose needle costs recall and not precision. */
    let needle = key(path)
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .to_string();
    if needle.is_empty() {
        return Vec::new();
    }
    let rows = crate::store::touches_near(&conn, &needle, 600);
    let titles = crate::store::roster(&conn, None).unwrap_or_default();
    drop(conn);

    let mut out: Vec<String> = Vec::new();
    for t in rows {
        if t.conversation_id == caller || t.op != "write" || !under(path, &t.path) {
            continue;
        }
        let name = titles
            .iter()
            .find(|r| r.id == t.conversation_id)
            .map(|r| {
                let title = r.title.trim();
                if title.is_empty() {
                    crate::relay::handle_of(&r.id)
                } else {
                    format!("{title} ({})", crate::relay::handle_of(&r.id))
                }
            })
            .unwrap_or_else(|| {
                format!("{} — closed since", crate::relay::handle_of(&t.conversation_id))
            });
        if !out.contains(&name) {
            out.push(name);
        }
        if out.len() >= 8 {
            break;
        }
    }
    out
}

/// Dev server groups that are up in a territory containing this path.
///
/// A group has no directory of its own — it runs at its territory's root — so
/// the containment test is against that root, and the answer is honest about
/// what it means: *a server is running in this tree*, which is what makes
/// deleting a build cache under it cost somebody a recompile.
fn servers_over(app: &AppHandle, path: &str) -> Vec<String> {
    let Some(store) = app.try_state::<crate::store::Store>() else {
        return Vec::new();
    };
    let Ok(conn) = store.0.lock() else {
        return Vec::new();
    };
    let projects = crate::store::projects(&conn).unwrap_or_default();
    let mut candidates: Vec<(String, String, String)> = Vec::new();
    for p in projects.iter().filter(|p| under(&p.root_path, path)) {
        for g in crate::store::server_groups_for(&conn, &p.id).unwrap_or_default() {
            candidates.push((g.id, g.label, p.name.clone()));
        }
    }
    drop(conn);
    if candidates.is_empty() {
        return Vec::new();
    }

    let up = crate::servers::running_ids(app);
    candidates
        .into_iter()
        .filter(|(id, _, _)| up.contains(id))
        .map(|(_, label, project)| format!("{label} ({project})"))
        .collect()
}

/// Where the caller stands, and what the wall says is off limits.
fn ground(app: &AppHandle, caller: &str) -> Result<Ground, String> {
    let store = app
        .try_state::<crate::store::Store>()
        .ok_or_else(|| "the store is unavailable".to_string())?;
    let conn = store
        .0
        .lock()
        .map_err(|_| "the store is unavailable".to_string())?;
    let me = crate::store::roster_one(&conn, caller)
        .ok_or_else(|| "this conversation is not on the wall.".to_string())?;
    if me.kind == "chat" {
        return Err(
            "this is a chat card: it reaches nothing on this machine and has no working \
             directory, so it cannot delete anything here. Ask on a project card."
                .into(),
        );
    }
    /* The directory the *child* runs in, which is the worktree where there is
       one and the territory root where there is not — `store::session_of`'s
       distinction, and the one that matters here because it is the ground the
       refusal is measured against. */
    let cwd = crate::store::session_of(&conn, caller)
        .map(|(dir, _)| dir)
        .unwrap_or(me.cwd);
    let roots: Vec<String> = crate::store::projects(&conn)
        .unwrap_or_default()
        .into_iter()
        .map(|p| p.root_path)
        .collect();
    drop(conn);

    Ok(Ground {
        cwd,
        roots,
        home: std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_default(),
    })
}

/* ── the call ─────────────────────────────────────────────────────────────*/

/// Every tool here that may have to wait for a person, in one entry point.
///
/// `docket::writes`' contract, for its reason: **which tools park is this
/// module's business.** A tool that ought to park, left out of a list kept over
/// in `ask.rs`, is an unattended delete with nothing anywhere to say so.
pub(crate) fn writes(
    app: &AppHandle,
    caller: &str,
    tool: &str,
    args: &Value,
) -> Option<Writing> {
    (tool == REMOVE_TOOL).then(|| remove(app, caller, args))
}

fn remove(app: &AppHandle, caller: &str, args: &Value) -> Writing {
    let g = match ground(app, caller) {
        Ok(g) => g,
        Err(why) => return Writing::Now(why),
    };

    let reason = args
        .get("reason")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if reason.is_empty() {
        /* Refused before anybody is asked, and it is not a formality: the reason
           is the sentence the user is deciding on. A question that says only
           "a card wants to delete this" is one where the only information is the
           path, which is the four-gesture prose ask this tool exists to replace. */
        return Writing::Now(
            "`reason` is required and was empty. It is what the user actually reads — say \
             what is broken and what removing it unblocks. Nothing was deleted and nobody \
             was asked."
                .into(),
        );
    }

    let named = paths_from(args);
    if named.is_empty() {
        return Writing::Now(
            "no usable path was given. `paths` takes one string or a list of them, absolute \
             or relative to this card's working directory."
                .into(),
        );
    }
    if named.len() > MAX_PATHS {
        return Writing::Now(format!(
            "{} paths in one call is more than anybody will read to the end of, and an unread \
             confirmation is worse than none. Name at most {MAX_PATHS}, in the groups they \
             actually belong to.",
            named.len()
        ));
    }

    let base = PathBuf::from(&g.cwd);
    let mut surveys: Vec<Survey> = Vec::new();
    for p in &named {
        let joined = base.join(p);
        /* Canonicalized where it can be, so `..` and a short 8.3 name and a
           case-variant all reduce to the one spelling the refusals compare on.
           A path that does not exist cannot be canonicalized, and that is the
           case `refuse` reports rather than an error — so the fallback keeps the
           joined form and lets the survey say it is not there. */
        let abs = std::fs::canonicalize(&joined).unwrap_or(joined);
        let abs = PathBuf::from(
            abs.to_string_lossy()
                .trim_start_matches(r"\\?\")
                .to_string(),
        );
        surveys.push(survey(app, caller, &abs));
    }

    for s in &surveys {
        if let Some(why) = refuse(s, &g) {
            return Writing::Now(why);
        }
    }

    let targets: Vec<String> = surveys.iter().map(|s| s.path.clone()).collect();
    let q = question(reason, &surveys);

    Writing::Ask {
        question: q,
        settle: Box::new(move |app, answer| {
            let Some(answer) = answer else {
                return unanswered();
            };
            if !approved(answer) {
                return declined(answer);
            }
            settle_delete(app, &targets)
        }),
    }
}

/// Do the deleting, on the parking thread, after the click.
///
/// **The refusals are re-checked here and the survey is not**, and the asymmetry
/// is the whole of what this function has to get right. `docket` does not re-read
/// on approval because the only thing that can have changed is on Asana's side;
/// here the ten minutes a question can stand are ten minutes in a working tree
/// several cards are editing, so a directory that was clean when the question
/// went up can be holding somebody's unwritten work by the time it is answered.
/// `spawn::close` states the rule this borrows — the settle is the last moment
/// at which the wall is still current.
///
/// The *reading* is deliberately not refreshed. Size and file count informed a
/// decision that has now been taken, and re-walking nine thousand files to
/// produce a number nobody will see would only widen the window between the
/// check and the delete.
fn settle_delete(app: &AppHandle, targets: &[String]) -> String {
    let Ok(g) = ground_for_settle(app) else {
        return "the wall could not be read at the moment of deleting, so nothing was \
                deleted. Try again."
            .to_string();
    };

    let mut done: Vec<String> = Vec::new();
    let mut failed: Vec<String> = Vec::new();

    for t in targets {
        let s = survey_light(t);
        if let Some(why) = refuse(&s, &g) {
            failed.push(format!(
                "{t} — not deleted, and this was true at the moment of deleting rather than \
                 when you asked: {why}"
            ));
            continue;
        }
        let p = Path::new(t);
        let r = if s.is_dir {
            std::fs::remove_dir_all(p)
        } else {
            std::fs::remove_file(p)
        };
        match r {
            Ok(()) => done.push(t.clone()),
            Err(e) => failed.push(format!("{t} — {e}")),
        }
    }

    let mut out = String::new();
    if !done.is_empty() {
        out.push_str(&format!(
            "deleted, permanently — not in the recycle bin and not recoverable from here:\n{}",
            done.iter().map(|p| format!("  {p}\n")).collect::<String>()
        ));
    }
    if !failed.is_empty() {
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(&format!(
            "not deleted:\n{}",
            failed.iter().map(|p| format!("  {p}\n")).collect::<String>()
        ));
    }
    out
}

/// The ground, at settle time, with no card to be about.
///
/// The caller's `cwd` is not re-derived here — the card may have been closed
/// while the question stood, and a delete the user approved should not fail
/// because the asker went away. What is re-checked is everything that is a fact
/// about the *tree*: the territory roots and the git state.
fn ground_for_settle(app: &AppHandle) -> Result<Ground, String> {
    let store = app
        .try_state::<crate::store::Store>()
        .ok_or_else(|| "the store is unavailable".to_string())?;
    let conn = store
        .0
        .lock()
        .map_err(|_| "the store is unavailable".to_string())?;
    let roots: Vec<String> = crate::store::projects(&conn)
        .unwrap_or_default()
        .into_iter()
        .map(|p| p.root_path)
        .collect();
    drop(conn);
    Ok(Ground {
        cwd: String::new(),
        roots,
        home: std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_default(),
    })
}

/// Just enough of a survey to re-run the refusals: no walk, no wall.
fn survey_light(path: &str) -> Survey {
    let abs = Path::new(path);
    let md = std::fs::symlink_metadata(abs).ok();
    let mut s = Survey {
        path: path.to_string(),
        exists: md.is_some(),
        is_dir: md.as_ref().is_some_and(|m| m.is_dir()),
        ..Default::default()
    };
    if !s.exists {
        return s;
    }
    let ask_from = if s.is_dir { abs } else { abs.parent().unwrap_or(abs) };
    if let Some(top) = git(ask_from, &["rev-parse", "--show-toplevel"]) {
        let root = top.trim().to_string();
        if !root.is_empty() {
            s.repo_root = Some(root.replace('/', std::path::MAIN_SEPARATOR_STR));
        }
    }
    if s.repo_root.is_some() {
        s.dirty = git(
            ask_from,
            &["status", "--porcelain", "--untracked-files=no", "--", path],
        )
        .map(|o| {
            o.lines()
                .filter(|l| l.len() > 3)
                .map(|l| l[3..].trim().to_string())
                .collect()
        })
        .unwrap_or_default();
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(path: &str) -> Survey {
        Survey {
            path: path.to_string(),
            exists: true,
            is_dir: true,
            bytes: 5_690_000_000,
            files: 9627,
            ..Default::default()
        }
    }

    fn ground_at(cwd: &str) -> Ground {
        Ground {
            cwd: cwd.to_string(),
            roots: vec!["C:\\Users\\lyss\\workbench\\skein".into()],
            home: "C:\\Users\\lyss".into(),
        }
    }

    #[test]
    fn only_the_button_is_an_approval() {
        /* `docket::approved`'s rule, and the whole of the gate: the panel has a
           free-text field beside its buttons, so anything that is not the exact
           label is prose and must not be read as a yes. */
        assert!(approved("delete it"));
        assert!(approved("  Delete It  "));
        assert!(!approved("yes"));
        assert!(!approved("yes, but not the node_modules one"));
        assert!(!approved("delete it, but keep the manifest"));
        assert!(!approved(KEEP_IT));
        assert!(!approved(""));
        /* And not another module's yes. `docket` and `smith` both say `do it`,
           and this question is a different act. */
        assert!(!approved("do it"));
    }

    #[test]
    fn a_refusal_is_an_answer_and_says_so() {
        let said = declined(KEEP_IT);
        assert!(said.contains("said no"), "{said}");
        assert!(said.contains("do not ask again"), "{said}");
        /* And it says not to go looking for another route, which is the whole
           failure sink `14f2543e` recorded. */
        assert!(said.contains("another way"), "{said}");
    }

    #[test]
    fn anything_that_is_not_a_button_comes_back_verbatim() {
        let said = declined("only the .next one");
        assert!(said.contains("only the .next one"), "{said}");
        assert!(said.contains("neither button"), "{said}");
    }

    #[test]
    fn containment_is_decided_on_segments_and_not_on_letters() {
        /* The bug this is here to refuse: a plain `starts_with` makes
           `skein-old` a child of `skein`, and this predicate decides whether a
           delete is refused. */
        assert!(under("C:/work/skein", "C:/work/skein/.next"));
        assert!(under("C:/work/skein", "C:/work/skein"));
        assert!(!under("C:/work/skein", "C:/work/skein-old"));
        assert!(!under("C:/work/skein/.next", "C:/work/skein"));
        /* Separators and case are the filesystem's, not the caller's. */
        assert!(under("C:\\work\\skein", "c:/WORK/skein/dist"));
        assert!(under("C:/work/skein/", "C:/work/skein/dist"));
    }

    #[test]
    fn a_path_that_is_not_there_is_said_to_be_missing_rather_than_succeeding() {
        let mut s = dir("C:\\Users\\lyss\\workbench\\skein\\.next");
        s.exists = false;
        let why = refuse(&s, &ground_at("C:\\Users\\lyss\\workbench\\skein")).unwrap();
        assert!(why.contains("does not exist"), "{why}");
        /* And it says why that is not the same as done, because an agent told
           "nothing to do" acts as though the cleanup happened. */
        assert!(why.contains("already gone"), "{why}");
    }

    #[test]
    fn the_repository_itself_is_never_a_target() {
        let g = ground_at("C:\\Users\\lyss\\workbench\\skein");
        for p in [
            "C:\\Users\\lyss\\workbench\\skein\\.git",
            "C:\\Users\\lyss\\workbench\\skein\\.git\\objects",
            "C:/Users/lyss/workbench/skein/.git/refs/heads",
        ] {
            let why = refuse(&dir(p), &g).unwrap_or_else(|| panic!("{p} was allowed"));
            assert!(why.contains(".git"), "{why}");
        }
        /* And a directory that merely has `git` in its name is not it. */
        assert!(touches_git_dir("C:/a/.git/b"));
        assert!(!touches_git_dir("C:/a/gitignore-samples/b"));
        assert!(!touches_git_dir("C:/a/.github/workflows"));
    }

    #[test]
    fn a_root_of_anything_is_refused() {
        let g = ground_at("C:\\Users\\lyss\\workbench\\skein");

        /* A filesystem root. */
        assert!(is_root("C:\\"));
        assert!(is_root("C:/"));
        assert!(is_root("/"));
        assert!(is_root("\\\\server\\share"));
        assert!(!is_root("C:/Users"));
        assert!(!is_root("\\\\server\\share\\thing"));

        /* The user's home. */
        let why = refuse(&dir("C:\\Users\\lyss"), &g).unwrap();
        assert!(why.contains("home directory"), "{why}");

        /* A territory root on the wall. */
        let why = refuse(&dir("C:\\Users\\lyss\\workbench\\skein"), &g).unwrap();
        assert!(why.contains("territory root") || why.contains("running in"), "{why}");

        /* A git work tree's root, even where the wall has never heard of it. */
        let mut s = dir("C:\\elsewhere\\repo");
        s.repo_root = Some("C:\\elsewhere\\repo".into());
        let why = refuse(&s, &g).unwrap();
        assert!(why.contains("git work tree"), "{why}");
    }

    #[test]
    fn the_ground_the_card_stands_on_is_refused_and_a_sibling_is_not() {
        let g = ground_at("C:\\Users\\lyss\\workbench\\skein");

        /* An ancestor of the card's own cwd takes the ground out from under the
           turn asking for it. */
        let why = refuse(&dir("C:\\Users\\lyss\\workbench"), &g).unwrap();
        assert!(why.contains("running in"), "{why}");

        /* A sibling territory's build cache is *not* refused — a card clearing
           another project's `.next` is a real thing to want, and it is asked
           about like anything else. */
        assert!(refuse(&dir("C:\\Users\\lyss\\workbench\\nova\\.next"), &g).is_none());
    }

    #[test]
    fn uncommitted_tracked_work_is_refused_and_the_refusal_says_whose_it_might_be() {
        let mut s = dir("C:\\Users\\lyss\\workbench\\skein\\src");
        s.repo_root = Some("C:\\Users\\lyss\\workbench\\skein".into());
        s.tracked = 240;
        s.dirty = vec!["src/lib/theme.ts".into(), "src/lib/pick.ts".into()];
        let why = refuse(&s, &ground_at("C:\\Users\\lyss\\workbench\\skein")).unwrap();

        assert!(why.contains("src/lib/theme.ts"), "{why}");
        assert!(why.contains("2 tracked file"), "{why}");
        /* Sink `8404a6ca` arriving in a new realm: in a shared checkout the
           dirty half is frequently somebody else's, and the refusal has to say
           so or it reads as being about the reader's own work. */
        assert!(why.contains("not yours"), "{why}");
        assert!(why.contains("mcp__skein__touched"), "{why}");
    }

    #[test]
    fn a_build_cache_full_of_untracked_files_is_allowed_through_to_the_question() {
        /* The case the whole tool was built for. `.next` is gitignored, so git
           tracks none of it and `status --untracked-files=no` says nothing —
           and a version of this that refused on untracked files would refuse
           every case there is. */
        let mut s = dir("C:\\Users\\lyss\\workbench\\nova\\.next");
        s.repo_root = Some("C:\\Users\\lyss\\workbench\\nova".into());
        s.tracked = 0;
        s.dirty = vec![];
        assert!(refuse(&s, &ground_at("C:\\Users\\lyss\\workbench\\skein")).is_none());
    }

    #[test]
    fn the_question_carries_the_five_things_a_path_cannot_say() {
        /* Sink `394430bf` named these, and they are the whole value of this
           tool over an agent asking in prose. */
        let mut s = dir("C:\\Users\\lyss\\workbench\\nova\\.next");
        s.repo_root = Some("C:\\Users\\lyss\\workbench\\nova".into());
        s.tracked = 0;
        s.writers = vec!["auditing nova (32e394af)".into()];
        s.servers = vec!["nova dev (nova)".into()];

        let q = question("clearing a corrupt turbopack manifest", &[s]);
        let body = q["questions"][0]["question"].as_str().unwrap();

        assert!(body.contains("C:\\Users\\lyss\\workbench\\nova\\.next"), "{body}");
        assert!(body.contains("5.3 GB"), "{body}");
        assert!(body.contains("9627"), "{body}");
        assert!(body.contains("untracked"), "{body}");
        assert!(body.contains("auditing nova (32e394af)"), "{body}");
        assert!(body.contains("nova dev (nova)"), "{body}");
        assert!(body.contains("cold recompile"), "{body}");
        assert!(body.contains("clearing a corrupt turbopack manifest"), "{body}");
    }

    #[test]
    fn the_question_says_it_cannot_be_taken_back() {
        /* The one sentence in the question that is not a reading, and the one
           the design rests on: the confirmation *is* the safety, so it must not
           let anybody believe there is a way back. */
        let q = question("stale", &[dir("C:\\x\\dist")]);
        let body = q["questions"][0]["question"].as_str().unwrap();
        assert!(body.contains("permanent"), "{body}");
        assert!(body.contains("recycle bin"), "{body}");
    }

    #[test]
    fn the_question_always_names_both_buttons() {
        let q = question("stale", &[dir("C:\\x\\dist")]);
        let opts = q["questions"][0]["options"].as_array().unwrap();
        assert_eq!(opts.len(), 2);
        assert_eq!(opts[0]["label"], DELETE_IT);
        assert_eq!(opts[1]["label"], KEEP_IT);
        assert!(opts[0]["detail"].as_str().unwrap().contains("for good"));
    }

    #[test]
    fn a_capped_walk_reads_as_a_floor_rather_than_a_count() {
        /* A number that is really "at least this" drawn as though it were exact
           is the reassuring direction, which this codebase refuses everywhere. */
        let mut s = dir("C:\\x\\node_modules");
        s.capped = true;
        let q = question("stale", &[s]);
        let body = q["questions"][0]["question"].as_str().unwrap();
        assert!(body.contains("more than"), "{body}");
    }

    #[test]
    fn sizes_read_in_the_register_the_decision_is_made_in() {
        assert_eq!(human_size(0), "0 B");
        assert_eq!(human_size(512), "512 B");
        assert_eq!(human_size(2048), "2.0 KB");
        assert_eq!(human_size(5_690_000_000), "5.3 GB");
        /* Past a hundred the decimal is noise, and three digits plus a decimal
           reads as precision nobody has. */
        assert_eq!(human_size(600 * 1024 * 1024), "600 MB");
    }

    #[test]
    fn paths_come_in_as_one_or_many_and_never_twice() {
        assert_eq!(paths_from(&json!({ "paths": ".next" })), vec![".next"]);
        assert_eq!(
            paths_from(&json!({ "paths": [".next", "dist"] })),
            vec![".next", "dist"]
        );
        /* The same place spelled two ways is one target, or the question lists
           it twice and the delete runs twice. */
        assert_eq!(
            paths_from(&json!({ "paths": ["C:/a/b", "C:\\a\\b", "  "] })),
            vec!["C:/a/b"]
        );
        assert!(paths_from(&json!({})).is_empty());
        assert!(paths_from(&json!({ "paths": 5 })).is_empty());
    }

    #[test]
    fn the_schema_leads_with_the_habit_it_replaces() {
        /* Sink `d3a1921a`: a capability an agent has a habit against is
           indistinguishable from one that does not exist, and the only thing a
           description can do about it is name the habit in its opening breath —
           `pull_request`'s form. */
        let d = remove_schema()["description"].as_str().unwrap().to_string();
        let opening = &d[..d.find("\n\n").unwrap_or(d.len())];
        assert!(opening.contains("rm -rf"), "{opening}");
        assert!(opening.contains("instead of"), "{opening}");
        /* And it names the workarounds, because naming only `rm -rf` is what
           left `mv` looking like a different act (sink `14f2543e`). */
        assert!(d.contains("Remove-Item"), "{d}");
        assert!(d.contains("find"), "{d}");
        assert!(d.contains("mv"), "{d}");
    }

    #[test]
    fn the_schema_promises_no_self_serve_tier_and_no_way_back() {
        let d = remove_schema()["description"].as_str().unwrap().to_string();
        assert!(d.contains("Every call asks"), "{d}");
        assert!(d.contains("permanent"), "{d}");
        assert!(d.contains("recycle bin"), "{d}");
        /* Both arguments are required, and `reason` is the one a model will
           want to leave out — it is the sentence the user decides on. */
        let req = remove_schema()["inputSchema"]["required"].clone();
        assert_eq!(req, json!(["paths", "reason"]));
    }
}
