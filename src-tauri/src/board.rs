//! The billboard: what a card wants every other card to know before it starts.
//!
//! `send` is a message to somebody. This is a notice to nobody in particular —
//! "I am reworking the transcript panel this afternoon, leave `markdown.ts`
//! alone" — and the difference that matters is what each costs. Reading the
//! board is free and reaches the whole wall; a `send` costs the recipient a
//! turn and reaches one card. So an agent that wants to know who is working
//! nearby should read the board *first*, and only send once it knows who to
//! send to. Both tool descriptions say so.
//!
//! Three tools, and there are three rather than two because taking a notice
//! down has to be as obvious as putting one up. A board nobody clears is a
//! board nobody believes, and the failure mode is quiet: every notice on it
//! stays true-looking forever, so the first thing an agent learns is that the
//! board is out of date and can be skipped.
//!
//! **Clearing therefore has four mechanisms, in descending order of how much
//! they can be relied on.** Only the first works without anybody remembering:
//!
//! 1. A card that closes takes its notices with it (`store::sweep_notices`,
//!    called when a card closes and again on every read as the crash backstop).
//!    The commonest stale notice by a long way is one from a card that finished
//!    and went away.
//! 2. Clearing a card clears its notices — a reset card is not still doing what
//!    it said it was doing.
//! 3. A notice untouched for `STALE_AFTER` is *marked* stale in every reading,
//!    to the agent and on the wall. Marked, never removed: a long refactor is a
//!    real thing, and deleting a true notice is worse than showing an old one.
//! 4. Your own notices are listed first, under a line saying they are yours to
//!    take down, and the receipt for posting one says the same.
//!
//! And the notice can reach out. A notice carrying `paths` is served to any
//! card that touches a file it covers, once — see `on_touch`, which is the only
//! part of this that does not wait to be asked.

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::store::{Notice, Store};

pub const BOARD_TOOL: &str = "board";
pub const POST_TOOL: &str = "post";
pub const UNPOST_TOOL: &str = "unpost";

/// How many notices one card may have up at once, and how many of those may be
/// about nothing in particular.
///
/// **Two numbers rather than one, because a notice's cost is not uniform.** It
/// was one — four, on the argument that four is more than any honest use and
/// few enough that the board stays a page — and the second half of that was
/// never true anyway: the cap is per *card*, so what bounds the board's length
/// is how many cards are live, not this. What it actually buys is that one card
/// cannot paper the board, which is worth having and is the reason it is
/// refused rather than rotated — an agent whose oldest notice was silently
/// dropped would go on believing the wall had been told.
///
/// The reason it had to be split is that one number priced two different
/// objects at the same rate, and squeezed out the useful one. A notice with no
/// `paths` is pure broadcast: every card that reads the board reads it, and it
/// reaches nobody who did not think to look. That is what four was written for
/// and four is still right for it. A notice **carrying** `paths` is a different
/// thing already — `on_touch` serves it to the card that writes a file it
/// covers and to nobody else, so its cost falls on the one agent it was written
/// for. Those are numerous, short-lived and mechanical, and a card coordinating
/// a nine-way split legitimately wants more than four of them.
///
/// Paid for on 2026-08-27: a card claiming `.claude/rules/hooks.md` was refused
/// for the four-notice cap, judged the work small, and carried on with no
/// claim. A sibling committed that file minutes later — with an explicit
/// pathspec, which does not help, since `git commit -- <path>` commits the
/// *working-tree* content of that path — and took a hundred lines of somebody
/// else's work with it under a message about something else. In a shared tree
/// the board claim is not decoration; it is the only thing standing between two
/// cards and a mixed commit. So the refusal below says that, and this cap no
/// longer squeezes the kind of notice that says it.
const MAX_PER_CARD: usize = 8;
const MAX_UNPATHED: usize = 4;
const MAX_SUBJECT: usize = 120;

/// The most a notice may say.
///
/// Doubled from 1,200 the same day and for the same incident: the longest
/// honest notice anybody has written here is a standing protocol for a shared
/// tree, and it wanted about twice what it got. It did not get it — it went up
/// cut off mid-sentence, and the receipt said "posted". See `clip`, which is
/// the half of this that actually mattered.
///
/// Still bounded, and not generously. Reading the board is free and reaches the
/// whole wall — that is the entire argument for preferring it to a `send`, and
/// a board that costs a page of context to glance at is a board agents stop
/// glancing at. `relay::MAX_BODY` is 4,000 because a message is delivered once
/// to one card; a notice is read by everyone, every time.
const MAX_BODY: usize = 2_400;
const MAX_GLOBS: usize = 8;

/// When a notice starts being asked whether it is still true.
///
/// Ninety minutes. Long enough to cover the piece of work most notices are
/// about, short enough that one left up over lunch says so. The number lives
/// here and only here — the wall draws `stale` off the row rather than
/// recomputing it, so the widget and the agent cannot disagree about what is
/// current.
const STALE_AFTER_MS: i64 = 90 * 60 * 1_000;

#[derive(Clone, Serialize)]
struct BoardChanged {
    /// Which board moved, so a widget showing the other one need not re-read.
    /// `null` for the wall-wide board.
    project_id: Option<String>,
}

fn changed(app: &AppHandle, project_id: Option<String>) {
    let _ = app.emit("board:changed", BoardChanged { project_id });
}

/* ── globs ────────────────────────────────────────────────────────────────
 *
 * Small and deliberately forgiving, because the alternative is worse in one
 * direction only: a glob that matches too little is a notice that never
 * reaches the agent it was written for, and looks exactly like the feature
 * working. A glob that matches too much costs somebody one paragraph they did
 * not need.
 *
 * So `src/lib/store.rs` matches the *tail* of a path — the agent writes what it
 * would type, not the absolute path SQLite happens to be holding — and a
 * pattern with no separator in it matches the basename, since `*.rs` obviously
 * means "any Rust file" and not "a Rust file in the drive root".
 */

/// Backslashes to forward, and case folded. Windows paths arrive in both
/// spellings from the same agent within one turn, and `C:\` and `c:/` are the
/// same directory.
pub fn normalize(path: &str) -> String {
    path.replace('\\', "/").to_lowercase()
}

/// Does this pattern cover this path?
///
/// `*` is a run within one segment, `**` crosses separators, `?` is one
/// character that is not one.
pub fn covers(pattern: &str, path: &str) -> bool {
    let pat = normalize(pattern.trim());
    if pat.is_empty() {
        return false;
    }
    let full = normalize(path);
    if !pat.contains('/') {
        let base = full.rsplit('/').next().unwrap_or(&full);
        return glob(&pat, base);
    }
    if glob(&pat, &full) {
        return true;
    }
    /* The tail, so `src/lib/store.rs` reaches
       `c:/users/…/skein/src/lib/store.rs`. Anchored at a separator, or `re.rs`
       would match `store.rs`. */
    let mut rest = full.as_str();
    while let Some(cut) = rest.find('/') {
        rest = &rest[cut + 1..];
        if glob(&pat, rest) {
            return true;
        }
    }
    false
}

/// Wildcard match over already-normalised strings.
///
/// Iterative with a backtrack point rather than recursive: the input is a model's
/// glob against a path, and a pattern like `**a**a**a**` on a long path is
/// exponential in the naive recursion. Nothing here is adversarial today, but a
/// frame loop is one module away and this runs on every write a card makes.
fn glob(pat: &str, s: &str) -> bool {
    let p: Vec<char> = pat.chars().collect();
    let t: Vec<char> = s.chars().collect();
    let (mut pi, mut ti) = (0usize, 0usize);
    /* Where to resume from if the current `*` turns out to have eaten too
       little. `None` means there is no star behind us to give ground. */
    let mut star: Option<(usize, usize, bool)> = None;

    while ti < t.len() {
        if pi < p.len() && p[pi] == '*' {
            let deep = pi + 1 < p.len() && p[pi + 1] == '*';
            let after = pi + if deep { 2 } else { 1 };
            star = Some((after, ti, deep));
            pi = after;
            continue;
        }
        if pi < p.len() && (p[pi] == t[ti] || (p[pi] == '?' && t[ti] != '/')) {
            pi += 1;
            ti += 1;
            continue;
        }
        match star {
            /* A single star may not swallow a separator; a double one may. */
            Some((after, at, deep)) if deep || t[at] != '/' => {
                pi = after;
                ti = at + 1;
                star = Some((after, at + 1, deep));
            }
            _ => return false,
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

fn globs_of(notice: &Notice) -> Vec<&str> {
    notice
        .paths
        .lines()
        .map(str::trim)
        .filter(|g| !g.is_empty())
        .collect()
}

pub fn stale(notice: &Notice, now: i64) -> bool {
    now - notice.touched_at > STALE_AFTER_MS
}

/* ── the tools ────────────────────────────────────────────────────────────── */

pub fn board_schema() -> Value {
    json!({
        "name": BOARD_TOOL,
        "description":
            "Read the billboard: standing notices other conversations on this Skein \
             wall have put up about work in progress — what they are reworking, what \
             to leave alone, what to wait for. **Read it before starting anything \
             substantial in a shared repository**, and read it again before messaging \
             another card to ask what they are doing, because the answer is usually \
             already here and reading costs nothing where a `send` costs that agent a \
             turn.\n\n\
             Your own notices are listed first. Anything marked stale has been up a \
             long time without being touched — if it is one of yours, either re-`post` \
             it to say it is still true or `unpost` it.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "scope": {
                    "type": "string",
                    "enum": ["project", "skein"],
                    "description":
                        "`project` (the default) is your own project's board plus any \
                         wall-wide notices — nearly always what you want. `skein` is \
                         every board in the studio."
                }
            }
        }
    })
}

pub fn post_schema() -> Value {
    json!({
        "name": POST_TOOL,
        "description":
            "Put a notice on the billboard, so every other conversation on this wall \
             knows what you are doing without anyone having to ask. Use it when you are \
             about to work across a module, take over a feature, or change something \
             others build on — 'reworking the transcript panel, leave markdown.ts \
             alone until I say'.\n\n\
             **Take it down with `unpost` the moment it stops being true.** A notice \
             you leave up after you have finished is worse than no notice: it stops \
             somebody else from working, and it teaches everyone here that the board \
             cannot be trusted. If a piece of work runs long, `post` the same subject \
             again to say it is still current.\n\n\
             Posting the same `subject` twice replaces your earlier notice rather than \
             adding a second.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "subject": {
                    "type": "string",
                    "description":
                        "What this is about, in a few words — 'reworking the store \
                         schema'. This is what identifies the notice, so use the same \
                         one to update it and a different one for a different piece of \
                         work."
                },
                "body": {
                    "type": "string",
                    "description":
                        "What you want the others to actually do: what you are \
                         changing, what they should hold off on, and what would tell \
                         them you are finished. Write it for another agent with its own \
                         context — name files by path."
                },
                "paths": {
                    "description":
                        "Optional. File globs this notice is about — 'src/lib/*.ts', \
                         'store.rs', 'src/lib/transcript.ts'. Any card that edits a \
                         file one of these covers is shown this notice once, \
                         automatically, so a notice with paths on it reaches the agent \
                         who needed it even if they never read the board. Give them \
                         whenever the work is about particular files; it is the single \
                         most useful thing on a notice.",
                    "anyOf": [
                        { "type": "string" },
                        { "type": "array", "items": { "type": "string" } }
                    ]
                },
                "scope": {
                    "type": "string",
                    "enum": ["project", "skein"],
                    "description":
                        "`project` (the default) posts to your own project's board. \
                         `skein` posts to the whole studio and is seen by every card in \
                         every project — for something that genuinely crosses them."
                }
            },
            "required": ["subject", "body"]
        }
    })
}

pub fn unpost_schema() -> Value {
    json!({
        "name": UNPOST_TOOL,
        "description":
            "Take one of your own notices off the billboard, because it is no longer \
             true. Do this as soon as the work it describes is done — it is the half \
             of the billboard that makes the other half worth reading, and nobody else \
             can do it for you.\n\n\
             Name it by its `subject` or by the id `board` reports, or pass \
             `all: true` to clear everything you have up, which is what to do when you \
             finish a piece of work.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "subject": { "type": "string", "description": "The notice's subject, or its id." },
                "all": {
                    "type": "boolean",
                    "description": "Take down every notice you have up."
                }
            }
        }
    })
}

/// Who is reading, and which board they get.
struct Reader {
    project_id: Option<String>,
    chat: bool,
}

fn reader(app: &AppHandle, id: &str) -> Reader {
    let store = app.state::<Store>();
    let row = store
        .0
        .lock()
        .ok()
        .and_then(|conn| crate::store::roster_one(&conn, id));
    match row {
        Some(r) => Reader {
            project_id: Some(r.project_id),
            chat: r.kind == "chat",
        },
        /* A card with no row is not a chat card — the unknown case falls to
           "an ordinary card" for the reason `store::kind_row` does. What it has
           no answer for is which project board is its own, so it reads the
           whole wall rather than nothing. */
        None => Reader { project_id: None, chat: false },
    }
}

/// A chat card stands outside the wall's projects and cannot reach this
/// machine; the board is a list of this machine's work. Same gate as `relay.rs`,
/// decided the same way — by asking the store, never the caller.
const NOT_FOR_CHAT: &str =
    "this is a chat card: it stands outside the wall's projects and has no billboard.";

fn do_board(app: &AppHandle, caller: &str, args: &Value) -> String {
    let me = reader(app, caller);
    if me.chat {
        return NOT_FOR_CHAT.into();
    }
    let all = args.get("scope").and_then(Value::as_str) == Some("skein");
    let store = app.state::<Store>();
    let Ok(conn) = store.0.lock() else {
        return "the store is unavailable".into();
    };
    crate::store::sweep_notices(&conn);
    let scope = if all { None } else { me.project_id.as_deref() };
    let notices = match crate::store::notices(&conn, scope) {
        Ok(n) => n,
        Err(e) => return format!("could not read the board: {e}"),
    };
    drop(conn);

    if notices.is_empty() {
        return "the billboard is empty — nobody has anything up.".into();
    }

    let now = crate::store::now();
    /* Yours first, and said out loud. The whole of nudge (4): an agent that
       sees its own notice at the top of every read it makes is an agent that
       remembers it is still up. */
    let (mine, theirs): (Vec<&Notice>, Vec<&Notice>) =
        notices.iter().partition(|n| n.from_id.as_deref() == Some(caller));

    let mut out = String::new();
    if !mine.is_empty() {
        out.push_str(
            "Yours, still up — take any of these down with `unpost` once they are no \
             longer true:\n\n",
        );
        for n in &mine {
            out.push_str(&render(n, now));
        }
        out.push('\n');
    }
    if theirs.is_empty() {
        out.push_str("Nobody else has anything up.");
    } else {
        out.push_str("From the other conversations on this wall:\n\n");
        for n in &theirs {
            out.push_str(&render(n, now));
        }
    }
    out
}

fn render(n: &Notice, now: i64) -> String {
    let who = match &n.from_id {
        Some(id) => crate::relay::handle_of(id),
        None => "the user".into(),
    };
    let age = ago(now - n.posted_at);
    let mark = if stale(n, now) {
        " — STALE, may no longer be true"
    } else {
        ""
    };
    let globs = globs_of(n);
    let files = if globs.is_empty() {
        String::new()
    } else {
        format!("\n  files: {}", globs.join(", "))
    };
    format!(
        "- [{}] {} (from {who}, {age}{mark})\n  {}{files}\n",
        n.id.chars().take(8).collect::<String>(),
        n.subject,
        n.body.replace('\n', "\n  "),
    )
}

fn ago(ms: i64) -> String {
    let mins = ms / 60_000;
    if mins < 1 {
        return "just now".into();
    }
    if mins < 60 {
        return format!("{mins}m ago");
    }
    let hours = mins / 60;
    if hours < 24 {
        return format!("{hours}h ago");
    }
    format!("{}d ago", hours / 24)
}

/* -- being refused ---------------------------------------------------------
 *
 * `relay.rs` states the rule these are written to, where `MAX_HOPS` used to be:
 * **a refusal must carry its reasoning and a way forward, because an agent told
 * only "no" will try a different phrasing of the same message.** A quota
 * message is the degenerate case of that -- it does not even give the agent a
 * different phrasing to try, so what it gets instead is the agent deciding the
 * announcement was optional and making the edit anyway.
 *
 * And there is a second thing worth naming, because it is what makes this
 * particular refusal dangerous rather than merely unhelpful. A `PreToolUse`
 * deny stops the tool call. This stops an *announcement about* a call the agent
 * then makes regardless: the notice and the edit are two separate acts and only
 * one of them was refused. Nothing downstream can recover that, so the whole of
 * the guard is what these strings say.
 */

/// Your own notices, likeliest-finished first, a line each.
///
/// The listing is the "way forward" half, and it is here rather than left to
/// the agent because being told "take one down" costs a `board` read to act on,
/// and an agent that has just been refused is an agent about to do something
/// else. Stale first and then longest-untouched, since the refusal's job is to
/// hand back the notice most likely to be finished with -- which, at ninety
/// minutes untouched, is what stale means.
fn yours(mine: &[&Notice], now: i64) -> String {
    let mut rows: Vec<&&Notice> = mine.iter().collect();
    rows.sort_by_key(|n| (!stale(n, now), n.touched_at));
    rows.iter()
        .map(|n| {
            let globs = globs_of(n);
            format!(
                "  - {:?} — untouched {}{} — {}\n",
                n.subject,
                ago(now - n.touched_at),
                if stale(n, now) { ", STALE" } else { "" },
                if globs.is_empty() {
                    "no files named".into()
                } else {
                    globs.join(", ")
                },
            )
        })
        .collect()
}

/// What being refused actually costs, in the terms the caller will feel it.
///
/// Split on whether the notice named files, because the two losses are not the
/// same one. A notice about the work is an announcement nobody heard. A notice
/// about *files* is a claim that does not exist -- and that is the sentence the
/// four-notice cap needed and did not have.
fn at_stake(paths: &str) -> String {
    if paths.is_empty() {
        return "Nothing was posted, so the wall has not been told what you are \
                doing."
            .into();
    }
    format!(
        "Nothing was posted, so **you do not have {}**. That is not bookkeeping. \
         A claim on this board is the only thing standing between two cards and a \
         mixed commit: `git commit -- <path>` guards the index, not the file — it \
         commits the *working-tree* content of that path, so a sibling committing \
         one of these takes your uncommitted edits to it along with their own, \
         under their message. Do not carry on unclaimed on the grounds that the \
         edit is small. That is exactly how a hundred lines of somebody's work \
         landed in the wrong commit on 2026-08-27, and it is the reason this \
         refusal is a paragraph rather than a number.",
        paths.lines().collect::<Vec<_>>().join(" or ")
    )
}

/// Out of slots altogether.
///
/// Pure over the caller's own notices, so the words an agent is actually
/// stopped by are asserted in `#[cfg(test)]` rather than only reachable through
/// a live wall. That matters more here than for most strings on the board: this
/// text *is* the guard — there is nothing downstream of it, since the edit it
/// hopes to prevent is a separate tool call nobody refused.
fn refuse_full(mine: &[&Notice], paths: &str, now: i64) -> String {
    format!(
        "this card already has {MAX_PER_CARD} notices up, which is the limit. {}\n\n\
         Take one down with `unpost` and post this again — or post it under a \
         subject you already have up, which replaces that notice rather than \
         adding one and costs nothing. Yours, likeliest-finished first:\n{}",
        at_stake(paths),
        yours(mine, now),
    )
}

/// Out of *bare* slots, with room left under the total.
///
/// The one refusal here that is also an argument for a feature. An agent that
/// hits this is one paragraph away from `paths`, which is the mechanism
/// `board.md` calls the single most useful thing on a notice and the only form
/// of claim this wall has — so the refusal spends its words pushing there
/// rather than on the number. Only reachable while the total has room, or the
/// way forward it offers would not work; `do_post` checks in that order.
fn refuse_bare(bare: &[&Notice], now: i64) -> String {
    format!(
        "this card already has {MAX_UNPATHED} notices up with no `paths` on them, \
         which is the limit for those. {}\n\n\
         **A notice that names files is capped at {MAX_PER_CARD}, not \
         {MAX_UNPATHED}, and you have room.** The low cap is for notices about \
         nothing in particular: every card that reads the board reads one of \
         those, and it reaches nobody who does not think to look. A notice with \
         globs on it is served straight to the card that writes a file it covers \
         and costs the rest of the wall nothing — which is also the only form of \
         claim this wall has. So if this is about particular files, and a notice \
         announcing work almost always is, name them in `paths` and post it \
         again.\n\n\
         Otherwise take one of these down with `unpost` — yours with no files \
         named, likeliest-finished first:\n{}",
        at_stake(""),
        yours(bare, now),
    )
}

fn do_post(app: &AppHandle, caller: &str, args: &Value) -> String {
    let me = reader(app, caller);
    if me.chat {
        return NOT_FOR_CHAT.into();
    }
    let Some(subject) = args.get("subject").and_then(Value::as_str) else {
        return "no `subject` was given, so nothing was posted".into();
    };
    let (subject, subject_cut) = clip(subject.trim(), MAX_SUBJECT);
    if subject.is_empty() {
        return "the subject was empty, so nothing was posted".into();
    }
    let (body, body_cut) = clip(
        args.get("body").and_then(Value::as_str).unwrap_or("").trim(),
        MAX_BODY,
    );
    if body.is_empty() {
        return "no `body` was given — a notice with no instruction in it tells nobody \
                anything, so nothing was posted"
            .into();
    }
    let (paths, globs_cut) = globs_from(args.get("paths"));
    let skein = args.get("scope").and_then(Value::as_str) == Some("skein");
    let project_id = if skein { None } else { me.project_id.clone() };
    if !skein && project_id.is_none() {
        return "this card is not on the wall, so it has no project board to post to".into();
    }

    let store = app.state::<Store>();
    let Ok(conn) = store.0.lock() else {
        return "the store is unavailable".into();
    };
    /* Counted after the sweep, or a card whose old notices died with a closed
       colleague would be refused against a board that no longer exists. */
    crate::store::sweep_notices(&conn);
    let all = crate::store::notices(&conn, None).unwrap_or_default();
    let mine: Vec<&Notice> = all
        .iter()
        .filter(|n| n.from_id.as_deref() == Some(caller))
        .collect();
    /* Replacing costs nothing against either cap — that is the whole of how a
       long piece of work says it is still true, and refusing it would make the
       `touched_at` refresh unreachable for exactly the card that most needs it. */
    let replacing = mine.iter().any(|n| n.subject == subject);
    if !replacing {
        let now = crate::store::now();
        /* The total first, and the order matters. The unpathed refusal below
           tells the agent that adding `paths` would let this through, and that
           is only true while there is room under the total — offering it at
           eight would be a way forward that does not work, which is the failure
           this whole change is about wearing a friendlier face. */
        if mine.len() >= MAX_PER_CARD {
            let refusal = refuse_full(&mine, &paths, now);
            drop(conn);
            return refusal;
        }
        let bare: Vec<&Notice> = mine
            .iter()
            .copied()
            .filter(|n| globs_of(n).is_empty())
            .collect();
        if paths.is_empty() && bare.len() >= MAX_UNPATHED {
            let refusal = refuse_bare(&bare, now);
            drop(conn);
            return refusal;
        }
    }

    let id = crate::store::uuid_v4();
    let put = crate::store::put_notice(
        &conn,
        &id,
        if skein { "skein" } else { "project" },
        project_id.as_deref(),
        Some(caller),
        &subject,
        &body,
        &paths,
    );
    drop(conn);

    match put {
        Err(e) => format!("could not post: {e}"),
        Ok(_) => {
            changed(app, project_id);
            let watching = if paths.is_empty() {
                String::new()
            } else {
                format!(
                    " Any card that edits {} will be shown it once, without having to \
                     look.",
                    paths.lines().collect::<Vec<_>>().join(" or ")
                )
            };
            format!(
                "posted to the {} board: {subject:?}.{watching}{} Take it down with \
                 `unpost` as soon as it is no longer true — a notice left up after the \
                 work is done stops somebody else for no reason.",
                if skein { "wall-wide" } else { "project" },
                lost(&subject, subject_cut, &body, body_cut, globs_cut),
            )
        }
    }
}

/// What did not go up, said on the receipt.
///
/// Empty in the ordinary case, so a notice that fitted reads exactly as before.
/// When something was cut it names the amount and where it stopped, because
/// "some of this was truncated" is a thing an agent can acknowledge and move
/// past, where "your body stops at …and the rest is gone" is one it has to
/// answer. See `clip`.
fn lost(subject: &str, subject_cut: usize, body: &str, body_cut: usize, globs_cut: usize) -> String {
    let mut out = String::new();
    if subject_cut > 0 {
        out.push_str(&format!(
            " The subject was {subject_cut} characters over the {MAX_SUBJECT} a subject \
             may be and now reads {subject:?} — check that is still the subject you \
             would `unpost` by."
        ));
    }
    if body_cut > 0 {
        out.push_str(&format!(
            " **{body_cut} characters were cut off the end of the body and are not on \
             the board.** A notice may say {MAX_BODY} characters and yours was {}. What \
             the wall has ends {:?} — everything after that was written for nobody. Post \
             the remainder under a second subject, or shorten it and post again.",
            MAX_BODY + body_cut,
            tail_of(body),
        ));
    }
    if globs_cut > 0 {
        out.push_str(&format!(
            " **{globs_cut} of the globs were dropped** — a notice may carry \
             {MAX_GLOBS} and only those are watched, so the files you named after the \
             {MAX_GLOBS}th are NOT claimed and nobody will be told about them. Post a \
             second notice for the rest."
        ));
    }
    out
}

/// The last few words of what actually went up, so a truncation says *where* it
/// stopped and not only that it did — which is the difference between an agent
/// that can see what it lost and one that has to diff the board against its own
/// draft to find out.
fn tail_of(s: &str) -> String {
    let n = s.chars().count();
    format!("…{}", s.chars().skip(n.saturating_sub(48)).collect::<String>())
}

fn do_unpost(app: &AppHandle, caller: &str, args: &Value) -> String {
    let store = app.state::<Store>();
    let me = reader(app, caller);
    let Ok(conn) = store.0.lock() else {
        return "the store is unavailable".into();
    };

    if args.get("all").and_then(Value::as_bool) == Some(true) {
        let n = crate::store::drop_notices_of(&conn, caller);
        drop(conn);
        changed(app, me.project_id);
        return match n {
            0 => "you had nothing up.".into(),
            1 => "took your notice down.".into(),
            n => format!("took all {n} of your notices down."),
        };
    }

    let Some(want) = args.get("subject").and_then(Value::as_str).map(str::trim) else {
        return "name the notice by its subject or its id, or pass `all: true`".into();
    };
    let mine: Vec<Notice> = crate::store::notices(&conn, None)
        .unwrap_or_default()
        .into_iter()
        .filter(|n| n.from_id.as_deref() == Some(caller))
        .collect();
    /* Id first, then the exact subject, then the id's short head — the same
       ladder `relay::resolve` walks, and for the same reason: the agent was
       given both spellings and either is a fair thing to type back. */
    let found = mine
        .iter()
        .find(|n| n.id == want)
        .or_else(|| mine.iter().find(|n| n.subject.eq_ignore_ascii_case(want)))
        .or_else(|| mine.iter().find(|n| n.id.starts_with(want) && want.len() >= 4));

    let Some(n) = found else {
        drop(conn);
        return if mine.is_empty() {
            "you have no notices up.".into()
        } else {
            format!(
                "no notice of yours called {want:?}. Yours are: {}",
                mine.iter()
                    .map(|n| format!("{:?}", n.subject))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        };
    };
    let subject = n.subject.clone();
    let gone = crate::store::drop_notice(&conn, &n.id, Some(caller));
    drop(conn);
    if gone {
        changed(app, me.project_id);
        format!("took {subject:?} down.")
    } else {
        format!("{subject:?} was already gone.")
    }
}

/// Turn whatever the model wrote into newline-separated globs, and say how many
/// were dropped past `MAX_GLOBS`.
///
/// The count for `clip`'s reason. A card naming twelve files it is taking over
/// and being watched on eight of them is a card that believes it has claimed
/// four files it has not — and the four it loses are the last four it wrote,
/// which nothing about the receipt would tell it.
fn globs_from(v: Option<&Value>) -> (String, usize) {
    let list: Vec<String> = match v {
        Some(Value::String(s)) => s
            .split(['\n', ','])
            .map(|g| g.trim().to_string())
            .filter(|g| !g.is_empty())
            .collect(),
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(|x| x.as_str())
            .map(|g| g.trim().to_string())
            .filter(|g| !g.is_empty())
            .collect(),
        _ => Vec::new(),
    };
    let dropped = list.len().saturating_sub(MAX_GLOBS);
    (
        list.into_iter().take(MAX_GLOBS).collect::<Vec<_>>().join("\n"),
        dropped,
    )
}

/// Clip to `max` characters, and say how many were lost.
///
/// **The count is the whole point, and it is the same defect as the refusal
/// above wearing a quieter face.** This returned only the string, so a notice
/// longer than `MAX_BODY` went up with its tail gone and the receipt said
/// "posted to the project board" and nothing else. On 2026-08-27 the notice
/// that happened to was THE PROTOCOL — the standing rules for an eleven-card
/// split, the one thing on the board every card was told to read first — which
/// stood cut off mid-sentence for an afternoon, with its author believing the
/// wall had the lot.
///
/// A cap that refuses is at least an event an agent has to answer. A cap that
/// truncates and says nothing produces a result the agent cannot tell went
/// wrong, which is strictly worse, and the fix is the same one `MAX_SENDS`
/// states for refusals: say what happened and what to do about it.
fn clip(s: &str, max: usize) -> (String, usize) {
    let n = s.chars().count();
    if n <= max {
        return (s.to_string(), 0);
    }
    (s.chars().take(max).collect(), n - max)
}

/* ── the notice that comes to you ─────────────────────────────────────────── */

/// A card just wrote to a file. Serve it any notice that covers it, once.
///
/// This is the only part of the billboard that does not wait to be asked, and
/// the honest framing is that it is a **notice served, not a lock**. Skein sees
/// the `tool_use` on the wire, which is the earliest moment it can know — but
/// the CLI queues a prompt written mid-turn behind the running turn, so what the
/// agent actually gets is "before you go further" rather than "before you
/// touch". There is no gate to hold: a project card runs with
/// `--dangerously-skip-permissions` and the edit is already being made when the
/// event arrives. Reading the board first is still the cheap way to find this
/// out; this is the backstop for when it did not.
///
/// Once per (notice, card) pair — `store::serve_notice` decides, atomically, so
/// a card making three edits in one turn is told once. Editing the notice clears
/// those marks, since new words are news again.
pub fn on_touch(app: &AppHandle, conversation_id: &str, path: &str) {
    let me = reader(app, conversation_id);
    if me.chat {
        return;
    }
    let Some(store) = app.try_state::<Store>() else { return };

    let candidates: Vec<Notice> = {
        let Ok(conn) = store.0.lock() else { return };
        crate::store::notices(&conn, me.project_id.as_deref())
            .unwrap_or_default()
            .into_iter()
            /* Never your own: a card being told about its own notice is a card
               being told what it already said. */
            .filter(|n| n.from_id.as_deref() != Some(conversation_id))
            .filter(|n| globs_of(n).iter().any(|g| covers(g, path)))
            .collect()
    };
    if candidates.is_empty() {
        return;
    }

    for n in candidates {
        let fresh = {
            let Ok(conn) = store.0.lock() else { return };
            crate::store::serve_notice(&conn, &n.id, conversation_id)
        };
        if !fresh {
            continue;
        }
        let from = n.from_id.as_ref().and_then(|id| {
            store
                .0
                .lock()
                .ok()
                .and_then(|conn| crate::store::roster_one(&conn, id))
        });
        let text = crate::relay::board_envelope(from.as_ref(), &n, path);
        /* Delivery is best effort and a failure is left *unserved* — no. It is
           left served, deliberately: the card is dormant, and a notice replayed
           at every wake for the rest of the day is a worse outcome than one
           missed. The board is still there to be read. */
        let ok = crate::supervisor::deliver(app, conversation_id, &text).is_ok();
        if ok {
            crate::relay::announce_board(app, &n, conversation_id);
        }
    }
}

/* ── the wall's way in ────────────────────────────────────────────────────
 *
 * The widget reads through these, and so does the control surface. Off the main
 * thread for `relay_send`'s reason where a write to a pipe is involved, and on
 * it where the work is a query — see the note there.
 */

fn as_json(n: &Notice, now: i64) -> Value {
    json!({
        "id": n.id,
        "scope": n.scope,
        "projectId": n.project_id,
        "from": n.from_id,
        "subject": n.subject,
        "body": n.body,
        "paths": globs_of(n),
        "postedAt": n.posted_at,
        "touchedAt": n.touched_at,
        /* Computed here rather than in the webview, so the reading an agent
           gets and the reading you get cannot disagree about what is current —
           see `STALE_AFTER_MS`. */
        "stale": stale(n, now),
    })
}

#[tauri::command]
pub fn read_board(app: AppHandle, project_id: Option<String>) -> Result<Value, String> {
    let store = app.state::<Store>();
    let conn = store.0.lock().map_err(|_| "the store is unavailable")?;
    crate::store::sweep_notices(&conn);
    let notices = crate::store::notices(&conn, project_id.as_deref())?;
    let now = crate::store::now();
    Ok(json!(notices.iter().map(|n| as_json(n, now)).collect::<Vec<_>>()))
}

/// Post as *yourself*. A notice with no card behind it, which is the one
/// instruction on this wall that reaches every agent without costing a turn.
#[tauri::command]
pub fn post_notice(
    app: AppHandle,
    subject: String,
    body: String,
    paths: Option<Vec<String>>,
    project_id: Option<String>,
) -> Result<String, String> {
    let (subject, subject_cut) = clip(subject.trim(), MAX_SUBJECT);
    if subject.is_empty() {
        return Err("a notice needs a subject".into());
    }
    let (body, body_cut) = clip(body.trim(), MAX_BODY);
    let (globs, globs_cut) = globs_from(paths.map(|p| json!(p)).as_ref());
    /* **Refused where a card's is clipped, and the asymmetry is the point.** An
       agent's post costs a turn, so cutting the tail and saying so on the
       receipt is the cheaper of two bad outcomes — see `clip`. Yours costs a
       keystroke: the text is still in the field in front of you, `Board.fault`
       already draws what came back, and shortening it is a moment's work. So
       nothing of yours goes up truncated. The rule under both is one rule —
       never silently keep less than was written. */
    if subject_cut > 0 || body_cut > 0 || globs_cut > 0 {
        let mut over: Vec<String> = Vec::new();
        if subject_cut > 0 {
            over.push(format!("the subject is {subject_cut} over {MAX_SUBJECT}"));
        }
        if body_cut > 0 {
            over.push(format!("the body is {body_cut} over {MAX_BODY}"));
        }
        if globs_cut > 0 {
            over.push(format!("{globs_cut} globs past the {MAX_GLOBS} a notice carries"));
        }
        return Err(format!("nothing posted — {}", over.join(", and ")));
    }
    let id = crate::store::uuid_v4();
    {
        let store = app.state::<Store>();
        let conn = store.0.lock().map_err(|_| "the store is unavailable")?;
        crate::store::put_notice(
            &conn,
            &id,
            if project_id.is_some() { "project" } else { "skein" },
            project_id.as_deref(),
            None,
            &subject,
            &body,
            &globs,
        )?;
    }
    changed(&app, project_id);
    Ok(id)
}

/// Take any notice down, including a card's — it is your wall.
#[tauri::command]
pub fn unpost_notice(app: AppHandle, id: String) -> Result<bool, String> {
    let gone = {
        let store = app.state::<Store>();
        let conn = store.0.lock().map_err(|_| "the store is unavailable")?;
        crate::store::drop_notice(&conn, &id, None)
    };
    changed(&app, None);
    Ok(gone)
}

/* Driving the three tools by hand, as a named card, so `wall.test.ts` can
 * exercise them without an agent taking a turn to make the call — the same seam
 * `relay_send` gives the roster. They return the tool's own words rather than a
 * structured result, deliberately: a refusal is a normal answer here, and a test
 * that asserted on a status code would be checking something no model ever
 * reads. Off the main thread for `relay_send`'s reason, since `do_post` can end
 * in an emit and `do_board` holds the store's lock across a sweep. */

#[tauri::command]
pub async fn relay_board(app: AppHandle, id: String, scope: Option<String>) -> Result<String, String> {
    crate::off_main(move || {
        do_board(&app, &id, &json!({ "scope": scope.unwrap_or_else(|| "project".into()) }))
    })
    .await
}

#[tauri::command]
pub async fn relay_post(
    app: AppHandle,
    id: String,
    subject: String,
    body: String,
    paths: Option<Vec<String>>,
    scope: Option<String>,
) -> Result<String, String> {
    crate::off_main(move || {
        let mut args = json!({ "subject": subject, "body": body });
        if let Some(p) = paths {
            args["paths"] = json!(p);
        }
        if let Some(s) = scope {
            args["scope"] = json!(s);
        }
        do_post(&app, &id, &args)
    })
    .await
}

#[tauri::command]
pub async fn relay_unpost(
    app: AppHandle,
    id: String,
    subject: Option<String>,
    all: Option<bool>,
) -> Result<String, String> {
    crate::off_main(move || {
        let mut args = json!({ "all": all.unwrap_or(false) });
        if let Some(s) = subject {
            args["subject"] = json!(s);
        }
        do_unpost(&app, &id, &args)
    })
    .await
}

/// A card wrote to a file. Called beside `record_file_touch`, from the one
/// place in the front end that folds a write out of the stream.
///
/// Async through `off_main` for `relay_send`'s reason: `on_touch` can end in a
/// write to another child's stdin, and that is the one thing here that can park
/// — see the note over the relay commands. Fire-and-forget from the webview, so
/// nothing waits on it either way.
#[tauri::command]
pub async fn board_touch(app: AppHandle, conversation_id: String, path: String) {
    let _ = crate::off_main(move || on_touch(&app, &conversation_id, &path)).await;
}

/// A card is going. Everything it had up goes with it — mechanism (1), and the
/// only one that needs nobody to remember anything.
pub fn clear_for(app: &AppHandle, conversation_id: &str) {
    let Some(store) = app.try_state::<Store>() else { return };
    let n = {
        let Ok(conn) = store.0.lock() else { return };
        crate::store::drop_notices_of(&conn, conversation_id)
    };
    if n > 0 {
        changed(app, None);
    }
}

/// Route a `tools/call` that belongs to the board. `None` for a name this file
/// does not claim, so `ask.rs` can go on asking.
pub fn handle(app: &AppHandle, conversation_id: &str, tool: &str, args: &Value) -> Option<String> {
    match tool {
        BOARD_TOOL => Some(do_board(app, conversation_id, args)),
        POST_TOOL => Some(do_post(app, conversation_id, args)),
        UNPOST_TOOL => Some(do_unpost(app, conversation_id, args)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn notice(paths: &str, touched: i64) -> Notice {
        Notice {
            id: "n1".into(),
            scope: "project".into(),
            project_id: Some("skein".into()),
            from_id: Some("aaaaaaaa-1111-4111-8111-111111111111".into()),
            subject: "reworking the store".into(),
            body: "leave store.rs alone".into(),
            paths: paths.into(),
            posted_at: 0,
            touched_at: touched,
        }
    }

    #[test]
    fn a_bare_name_matches_the_file_wherever_it_is() {
        /* `*.rs` obviously means "any Rust file" rather than "one in the drive
           root", so a pattern with no separator is matched against the base. */
        assert!(covers("store.rs", "C:/repo/src-tauri/src/store.rs"));
        assert!(covers("*.rs", "C:/repo/src/store.rs"));
        assert!(!covers("store.rs", "C:/repo/src/relay.rs"));
    }

    #[test]
    fn a_path_matches_the_tail_so_the_agent_can_write_what_it_would_type() {
        assert!(covers("src/lib/store.rs", "C:/repo/src/lib/store.rs"));
        assert!(covers("src-tauri/src/*.rs", "C:/repo/src-tauri/src/board.rs"));
        assert!(!covers("src/lib/store.rs", "C:/repo/other/lib/store.rs"));
    }

    /// Anchored at a separator, or a suffix would match half a filename.
    #[test]
    fn a_tail_match_starts_at_a_directory_boundary() {
        assert!(!covers("re/store.rs", "C:/repo/src/store.rs"));
        assert!(!covers("ib/store.rs", "C:/repo/lib/store.rs"));
    }

    #[test]
    fn one_star_stays_inside_a_segment_and_two_do_not() {
        assert!(!covers("src/*.ts", "C:/repo/src/lib/deep.ts"));
        assert!(covers("src/**/*.ts", "C:/repo/src/lib/deep.ts"));
        assert!(covers("src/**", "C:/repo/src/lib/deep.ts"));
    }

    #[test]
    fn windows_spells_a_path_two_ways_and_both_are_the_same_file() {
        assert!(covers("src/lib/Store.rs", "C:\\repo\\src\\lib\\store.rs"));
        assert!(covers("src\\lib\\store.rs", "C:/repo/src/lib/store.rs"));
    }

    /// The naive recursion is exponential on a pattern like this, and it runs on
    /// every write every card makes.
    #[test]
    fn a_pathological_pattern_still_answers_at_once() {
        let pat = "**a**a**a**a**a**a**b";
        let path = "/".to_string() + &"a".repeat(200);
        assert!(!covers(pat, &path));
    }

    #[test]
    fn an_empty_pattern_covers_nothing_rather_than_everything() {
        assert!(!covers("", "C:/repo/src/store.rs"));
        assert!(!covers("   ", "C:/repo/src/store.rs"));
        assert!(globs_of(&notice("", 0)).is_empty());
        assert!(globs_of(&notice("\n  \n", 0)).is_empty());
    }

    #[test]
    fn globs_arrive_as_a_string_or_a_list_and_are_capped() {
        assert_eq!(globs_from(Some(&json!("a.rs, b.rs"))).0, "a.rs\nb.rs");
        assert_eq!(globs_from(Some(&json!(["a.rs", " b.rs "]))).0, "a.rs\nb.rs");
        assert_eq!(globs_from(None), (String::new(), 0));
        let many: Vec<String> = (0..30).map(|i| format!("f{i}.rs")).collect();
        let (kept, dropped) = globs_from(Some(&json!(many)));
        assert_eq!(kept.lines().count(), MAX_GLOBS);
        /* The count, not just the cap. A card naming thirty files and watched
           on eight is claiming twenty-two it does not have, and the receipt is
           the only place that can say so. */
        assert_eq!(dropped, 30 - MAX_GLOBS);
    }

    /* ── what a limit does when it is reached ───────────────────────────────
     *
     * Two failures, one shape. The cap *refuses* and said only a number, so an
     * agent judged the work small and edited an unclaimed file. `clip`
     * *truncated* and said nothing at all, so THE PROTOCOL notice of
     * 2026-08-27 stood cut off mid-sentence with its author believing the wall
     * had the lot. Both are fixed the same way and are tested together on
     * purpose.
     */

    #[test]
    fn a_truncation_says_how_much_it_took() {
        assert_eq!(clip("short", 40), ("short".into(), 0));
        let long = "x".repeat(50);
        assert_eq!(clip(&long, 40), ("x".repeat(40), 10));
        /* Characters, not bytes — the cut must not land inside a code point. */
        let wide = "é".repeat(50);
        let (kept, cut) = clip(&wide, 40);
        assert_eq!(kept.chars().count(), 40);
        assert_eq!(cut, 10);
    }

    #[test]
    fn a_receipt_is_silent_about_what_fitted_and_loud_about_what_did_not() {
        assert_eq!(lost("s", 0, "b", 0, 0), "");
        let body = "the whole protocol, ending here and cut after this point";
        let out = lost("s", 0, body, 300, 0);
        assert!(out.contains("300 characters were cut"));
        /* Where it stopped, so the agent can see what it lost without diffing
           the board against its own draft. */
        assert!(out.contains("cut after this point"));
        assert!(out.contains(&format!("{}", MAX_BODY + 300)));
        assert!(lost("s", 0, "b", 0, 3).contains("NOT claimed"));
        assert!(lost("looong", 12, "b", 0, 0).contains("12 characters over"));
    }

    #[test]
    fn the_tail_shows_where_it_stopped_even_for_something_short() {
        assert_eq!(tail_of("abc"), "…abc");
        assert_eq!(tail_of(&"x".repeat(100)).chars().count(), 49);
    }

    /// **The whole of the item.** A refusal that says only "you are at the
    /// limit" is one an agent reads, judges the work small, and proceeds past
    /// — and it then makes the edit it was never refused, because the notice
    /// and the edit are two separate acts. `relay.rs` states the rule where
    /// `MAX_HOPS` used to be: a refusal must carry its reasoning and a way
    /// forward.
    #[test]
    fn a_refused_claim_says_what_the_claim_was_holding() {
        let out = at_stake("src-tauri/src/hooks.rs\n.claude/rules/hooks.md");
        assert!(out.contains("you do not have"));
        /* Both files named, so there is no doubt which are unguarded. */
        assert!(out.contains("hooks.rs") && out.contains("hooks.md"));
        /* The consequence, in the terms it will actually arrive in. */
        assert!(out.contains("mixed commit"));
        assert!(out.contains("git commit -- <path>"));
        assert!(out.contains("working-tree"));
        /* And the reflex it exists to stop, said out loud. */
        assert!(out.contains("edit is small"));
    }

    /// A notice about the work loses something different from a claim, and
    /// telling an agent it had lost a file it never named would be the same
    /// defect pointed the other way.
    #[test]
    fn a_refused_announcement_does_not_claim_to_have_lost_a_file() {
        let out = at_stake("");
        assert!(out.contains("has not been told"));
        assert!(!out.contains("you do not have"));
    }

    fn subject(s: &str, paths: &str, touched: i64) -> Notice {
        let mut n = notice(paths, touched);
        n.subject = s.into();
        n
    }

    /// The way forward has to be actionable without a second call. Being told
    /// "take one down" costs a `board` read to act on, and an agent that has
    /// just been refused is an agent about to do something else.
    #[test]
    fn a_refusal_hands_back_the_notice_likeliest_to_be_finished_with() {
        let now = STALE_AFTER_MS * 3;
        let fresh = subject("the azdo write side", "azdo.rs", now - 60_000);
        let old = subject("reworking the store", "", now - STALE_AFTER_MS * 2);
        let middling = subject("the flow", "layout.ts", now - 60 * 60_000);
        let mine: Vec<&Notice> = vec![&fresh, &old, &middling];

        let out = yours(&mine, now);
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines.len(), 3);
        /* Stale first, then longest-untouched. */
        assert!(lines[0].contains("reworking the store"));
        assert!(lines[0].contains("STALE"));
        assert!(lines[1].contains("the flow"));
        assert!(lines[2].contains("the azdo write side"));
        /* Each says what it is holding, so the one safe to drop is visible. */
        assert!(lines[0].contains("no files named"));
        assert!(lines[2].contains("azdo.rs"));
    }

    /// Two numbers rather than one, because the two notices cost different
    /// things — and the cheap cap must not be what squeezes out a file claim.
    #[test]
    fn a_claim_is_capped_more_generously_than_a_broadcast() {
        assert!(MAX_PER_CARD > MAX_UNPATHED);
        /* Four was right for prose and is kept for it. */
        assert_eq!(MAX_UNPATHED, 4);
    }

    #[test]
    fn being_out_of_slots_altogether_names_the_files_it_left_unguarded() {
        let now = 0;
        let held = subject("holding the panel", "Transcript.svelte", 0);
        let mine: Vec<&Notice> = vec![&held];
        let out = refuse_full(&mine, "src-tauri/src/hooks.rs", now);
        assert!(out.contains(&format!("{MAX_PER_CARD} notices up")));
        assert!(out.contains("you do not have"));
        assert!(out.contains("hooks.rs"));
        /* Both ways out, and the cheap one said to be cheap. */
        assert!(out.contains("unpost"));
        assert!(out.contains("replaces that notice"));
        /* The listing, so `unpost` can be called without reading the board. */
        assert!(out.contains("holding the panel"));
    }

    /// The one refusal that is also an argument for a feature: an agent out of
    /// bare slots is one paragraph away from the mechanism that actually
    /// reaches, so the words go there rather than on the number.
    #[test]
    fn being_out_of_bare_slots_points_at_the_form_that_still_has_room() {
        let a = subject("a thought", "", 0);
        let bare: Vec<&Notice> = vec![&a];
        let out = refuse_bare(&bare, 0);
        assert!(out.contains(&format!("capped at {MAX_PER_CARD}")));
        assert!(out.contains("name them in `paths`"));
        assert!(out.contains("only form of claim this wall has"));
        /* It must not say a file was lost — this call named none. */
        assert!(!out.contains("you do not have"));
        /* And it must not advise `paths` if that would not in fact help. The
           guarantee is `do_post`'s ordering; what is asserted here is that the
           two numbers differ, since equal ones make the advice a lie. */
        assert!(MAX_PER_CARD > MAX_UNPATHED);
    }

    /// Marked, never removed. A long refactor is a real thing, and deleting a
    /// true notice is worse than showing an old one.
    #[test]
    fn a_notice_goes_stale_by_being_left_alone_and_re_posting_revives_it() {
        let now = STALE_AFTER_MS * 2;
        assert!(stale(&notice("", 0), now));
        assert!(!stale(&notice("", now - 60_000), now));
    }

    #[test]
    fn the_reading_names_the_notice_its_author_and_its_files() {
        let out = render(&notice("src/lib/*.ts\nstore.rs", 0), 0);
        assert!(out.contains("reworking the store"));
        assert!(out.contains("aaaaaaaa"));
        assert!(out.contains("src/lib/*.ts, store.rs"));
        assert!(!out.contains("STALE"));
        assert!(render(&notice("", 0), STALE_AFTER_MS * 2).contains("STALE"));
    }

    #[test]
    fn a_notice_you_posted_says_so_rather_than_naming_a_card() {
        let mut n = notice("", 0);
        n.from_id = None;
        assert!(render(&n, 0).contains("the user"));
    }

    #[test]
    fn ages_read_as_prose() {
        assert_eq!(ago(0), "just now");
        assert_eq!(ago(5 * 60_000), "5m ago");
        assert_eq!(ago(3 * 3_600_000), "3h ago");
        assert_eq!(ago(50 * 3_600_000), "2d ago");
    }

    #[test]
    fn all_three_tools_say_what_they_take() {
        let b = board_schema();
        assert_eq!(b["name"], BOARD_TOOL);
        assert!(b["inputSchema"]["required"].is_null());

        let p = post_schema();
        assert_eq!(p["inputSchema"]["required"], json!(["subject", "body"]));
        /* Globs as a string or a list, since a model asked for "paths" writes
           either and a refused call is a notice that never went up. */
        assert!(p["inputSchema"]["properties"]["paths"]["anyOf"][1]["items"].is_object());

        let u = unpost_schema();
        assert_eq!(u["name"], UNPOST_TOOL);
        assert!(u["inputSchema"]["properties"]["all"].is_object());
        /* Nothing required: `all: true` is a whole call, and demanding a
           subject would refuse the one an agent makes when it finishes. */
        assert!(u["inputSchema"]["required"].is_null());
    }

    /// Taking one down has to be as loud as putting one up, or the board fills
    /// with notices that were true this morning.
    #[test]
    fn every_description_says_to_clear_it_up() {
        assert!(post_schema()["description"].as_str().unwrap().contains("unpost"));
        assert!(board_schema()["description"].as_str().unwrap().contains("unpost"));
        assert!(unpost_schema()["description"].as_str().unwrap().contains("as soon as"));
    }
}
