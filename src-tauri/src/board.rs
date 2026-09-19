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
//! **Clearing therefore has five mechanisms, in descending order of how much
//! they can be relied on.** Only the first two work without anybody remembering:
//!
//! 1. A card that closes takes its notices with it (`store::sweep_notices`,
//!    called when a card closes and again on every read as the crash backstop).
//!    The commonest stale notice by a long way is one from a card that finished
//!    and went away.
//! 2. A notice nobody has been behind for `EXPIRE_AFTER_MS` is taken down and
//!    its author told on its next wake (`sweep`, `expiry_note`). This is the one
//!    that reaches the notices nothing else can: a card killed mid-turn never
//!    unposts, never wakes to be asked, and `unpost` is poster-only — so before
//!    this, its hold stood for ever.
//! 3. Clearing a card clears its notices — a reset card is not still doing what
//!    it said it was doing.
//! 4. A notice nobody has been behind for `STALE_AFTER_MS` is *marked* stale in
//!    every reading, to the agent and on the wall. Marked, never removed: a long
//!    refactor is a real thing, and deleting a true notice is worse than showing
//!    an old one. Past that mark another card may also *offer* to retire it, and
//!    the user decides (`unpost`, `retire_question`).
//! 5. Your own notices are listed first, under a line saying they are yours to
//!    take down, and the receipt for posting one says the same.
//!
//! And the notice can reach out. A notice carrying `paths` is served to any
//! card that touches a file it covers, once — see `on_touch`, which is the only
//! part of this that does not wait to be asked.

use std::collections::HashMap;

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

/// How many globs one notice may watch.
///
/// **Twelve, raised from eight, and the raise is the smaller half of the
/// change** — `do_post` now *refuses* a list longer than this rather than
/// keeping the first `MAX_GLOBS` of it. See `refuse_globs`, which is where the
/// argument is.
///
/// Eight was chosen against no measurement. The honest lists people write are
/// longer: the card that filed this had eleven, none of it padding, for a
/// feature touching a front end, a back end, a test and a manifest — which is
/// the ordinary shape of a change in this repository and not an unusual one.
/// Twelve clears that with a little room and is still short enough that the
/// files line on a board read is a line rather than a paragraph. A card that
/// genuinely needs more is a card taking over a module, and `src/lib/**` says
/// that in one glob better than thirty names do.
const MAX_GLOBS: usize = 12;

/// When a notice starts being asked whether it is still true.
///
/// **The threshold is the smaller half of this too. What "untouched" means is
/// the rest of it.** It used to be the notice's own `touched_at` and ninety
/// minutes of it, and the result was a marker that fired on everything: a board
/// cleanup on 2026-09-13 found fifteen notices of which every single one was
/// labelled `STALE, may no longer be true`, two-hour-old ones included. A mark
/// that fires on everything is not a mark — it is a line the reader learns to
/// skip, and then the one notice that really was abandoned reads exactly like
/// the fourteen that were not (sink `b5453473`).
///
/// What was wrong is not the number, it is the question. A notice untouched for
/// three hours from a card that answered two minutes ago is live work — nobody
/// re-posts a notice every hour to say they are still typing. A notice
/// untouched for three hours from a card that has said nothing for three hours
/// is a different object. So the clock runs on the **later of the notice's
/// touch and its author's last turn** (`quiet_ms`): stale means the notice and
/// the card behind it have *both* gone quiet, which is the thing the reader was
/// trying to learn from the mark in the first place.
///
/// Four hours of that. Long enough to cover lunch and a review cycle on a card
/// that is between turns, short enough that one left overnight says so. The
/// number lives here and only here — the wall draws `stale` off the row rather
/// than recomputing it, so the widget and the agent cannot disagree about what
/// is current.
const STALE_AFTER_MS: i64 = 4 * 60 * 60 * 1_000;

/// When a notice stops being a claim at all and is taken down.
///
/// **This is the one clearing mechanism that reaches a notice nobody can
/// reach.** Every other one needs somebody to act: the poster unposts, the card
/// closes, you take it off the widget. A card that *died* mid-turn will never do
/// any of those, and `unpost` is poster-only, so its notice was structurally
/// immortal — and the notices that accumulate are exactly the wrong ones, since
/// a card that finishes cleanly tends to unpost and a card that dies leaves its
/// hold up for ever. Paid for in `rise` on 2026-09-12: a fourteen-day-old notice
/// from a dormant card reserved three of the most-edited files in the repository
/// against everybody, describing work that had already shipped (sink
/// `86e0f8b0`).
///
/// Three days of the same silence `stale` measures. It is deliberately not a
/// judgement made at the moment of the conflict — the alternative on the table
/// was letting a card override a notice it thought was finished, and the moment
/// an agent is about to edit a claimed file is precisely the moment it has the
/// least context to judge with, and the most reason to want the answer to be
/// yes. Expiry needs no such judgement from anybody.
///
/// Three rather than one because a weekend is two: a card parked on Friday
/// afternoon and picked up on Monday morning has been quiet for about sixty-four
/// hours, and a claim that cannot survive a weekend is one nobody will trust
/// with a piece of work that takes one. And it is not a deletion of the
/// knowledge — `expiry_note` goes to the author's inbox, so the card is told on
/// its next wake and can re-post in one call if the claim is somehow still live.
const EXPIRE_AFTER_MS: i64 = 3 * 24 * 60 * 60 * 1_000;

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

/// How long nobody has said anything on this notice's behalf.
///
/// Not the notice's own age, and that distinction is the whole of what makes
/// the stale mark mean something — see `STALE_AFTER_MS`. `seen` is when the
/// card that posted it last finished a turn, `None` for a notice you posted
/// yourself or a card that has never taken one; in both of those the notice's
/// own touch is all there is to go on, which is the old behaviour and is right
/// for them.
///
/// The later of the two, because either one is evidence the claim is still
/// being made: re-posting says so outright, and the author taking a turn says
/// there is somebody there to be asked.
pub fn quiet_ms(notice: &Notice, seen: Option<i64>, now: i64) -> i64 {
    let since = notice.touched_at.max(seen.unwrap_or(i64::MIN));
    (now - since).max(0)
}

pub fn stale(notice: &Notice, seen: Option<i64>, now: i64) -> bool {
    quiet_ms(notice, seen, now) > STALE_AFTER_MS
}

/// Past arguing about: nobody has been behind this notice for days.
pub fn expired(notice: &Notice, seen: Option<i64>, now: i64) -> bool {
    quiet_ms(notice, seen, now) > EXPIRE_AFTER_MS
}

/// When each card on the wall last finished a turn, for `quiet_ms`.
///
/// One query for the whole board rather than one per notice — `roster` is what
/// `relay::do_list` already asks on every listing, and a board is a handful of
/// rows. A card absent from it has been closed, and `sweep_notices` has already
/// taken its notices; a card present with no entry has never taken a turn, and
/// then the notice's own touch is all there is, which is what `quiet_ms` does
/// with `None`.
fn seen_map(conn: &rusqlite::Connection) -> HashMap<String, i64> {
    crate::store::roster(conn, None)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|r| r.last_turn_at.map(|t| (r.id, t)))
        .collect()
}

fn seen_of(seen: &HashMap<String, i64>, n: &Notice) -> Option<i64> {
    n.from_id.as_ref().and_then(|id| seen.get(id).copied())
}

/* ── the pass that runs on every reading ───────────────────────────────────
 *
 * Two clearings, one after the other, and the second is the one that reaches a
 * notice nobody else can. `sweep_notices` takes what went with a closed card;
 * `expire` takes what has outlived its author's attention. Both run before the
 * board is read rather than on a clock, for the reason nothing here polls: a
 * board nobody is looking at does not need to be tidy, and every reading is an
 * event that already exists.
 */

/// What a card is told, on its next wake, about the notices that came down.
///
/// **A notice is deleted, not archived, so this is the whole of what survives
/// it** — which is why it names the subject and the files rather than saying a
/// number. The card is being asked to make one decision: is this still true. It
/// can only make it if it is told what "this" was.
///
/// Written to be read in a transcript the user may be opening after a
/// fortnight, so it says what happened and what to do in two sentences and does
/// not ask for a reply. `b5453473` is explicit that a dormant card woken to find
/// a chore at the top of its transcript is a cost rather than a fix; the line
/// between the two is that this is news about something already done, not a job
/// handed over.
fn expiry_note(gone: &[Notice], quiet: i64) -> String {
    let listed: String = gone
        .iter()
        .map(|n| {
            let globs = globs_of(n);
            format!(
                "  - {:?}{}\n",
                n.subject,
                if globs.is_empty() {
                    String::new()
                } else {
                    format!(" — it was claiming {}", globs.join(", "))
                }
            )
        })
        .collect();
    format!(
        "{} of your billboard notices came down while this card was quiet. Nothing \
         went wrong: a notice describes work in flight, and neither it nor this card \
         had said anything for {} — so it stopped being a claim anybody could rely on \
         and the wall retired it.\n\n{listed}\n\
         If any of that work is still live, `mcp__skein__post` it again — the same \
         subject puts it straight back up. If it is finished, there is nothing to do \
         and nothing to reply to.",
        gone.len(),
        ago(quiet),
    )
}

/// Take down everything nobody is behind any more, and tell whoever posted it.
///
/// Called at the top of every reading — `do_board`, `do_post`, `read_board` and
/// `on_touch` — rather than on a timer.
fn sweep(app: &AppHandle) {
    let Some(store) = app.try_state::<Store>() else { return };
    let now = crate::store::now();
    let gone: Vec<(Notice, i64)> = {
        let Ok(conn) = store.0.lock() else { return };
        crate::store::sweep_notices(&conn);
        let seen = seen_map(&conn);
        /* A notice with no `from_id` is one *you* posted, and it never expires:
           nothing sweeps it away, it is yours to remove, and a wall's own
           standing instruction is not work in flight that can go quiet. */
        let doomed: Vec<(Notice, i64)> = crate::store::notices(&conn, None)
            .unwrap_or_default()
            .into_iter()
            .filter(|n| n.from_id.is_some())
            .map(|n| {
                let quiet = quiet_ms(&n, seen_of(&seen, &n), now);
                (n, quiet)
            })
            /* Through `expired` rather than comparing against `EXPIRE_AFTER_MS`
               here. The predicate is the vocabulary — `stale` and `expired` are
               a pair and both are asserted — and an inline comparison beside it
               is a second definition that can drift from the tested one without
               anything failing. It was inline, so `expired` was dead code with
               three assertions behind it: green, and guarding nothing the wall
               actually runs. */
            .filter(|(n, _)| expired(n, seen_of(&seen, n), now))
            .collect();
        for (n, _) in &doomed {
            crate::store::drop_notice(&conn, &n.id, None);
        }
        doomed
    };
    if gone.is_empty() {
        return;
    }

    /* One message per card rather than one per notice. A card that posted eight
       of these and went away is a card that would otherwise wake to eight
       separate lines saying the same thing. */
    let mut batches: Vec<(String, Vec<Notice>, i64)> = Vec::new();
    for (n, quiet) in gone {
        let Some(who) = n.from_id.clone() else { continue };
        match batches.iter_mut().find(|(id, _, _)| *id == who) {
            Some((_, list, longest)) => {
                *longest = (*longest).max(quiet);
                list.push(n);
            }
            None => batches.push((who, vec![n], quiet)),
        }
    }
    for (who, list, quiet) in &batches {
        let text = crate::relay::board_expiry_envelope(&expiry_note(list, *quiet));
        /* Into the inbox, and never a wake. The card has by definition not
           finished a turn in `EXPIRE_AFTER_MS`, so there is nobody there to read
           this now — and spending a process and an API turn on a sleeping card
           to tell it a notice came down is exactly the default `relay.md` argues
           against. `record_relay` with the card as its own sender is the shape
           `later.rs` already uses for a wake that missed its card: the row is
           what `spawn_conversation` drains, and `drain_inbox` hands a self-row
           over as written. */
        if let Ok(conn) = store.0.lock() {
            let _ = crate::store::record_relay(
                &conn,
                &crate::store::uuid_v4(),
                who,
                who,
                &text,
                &list[0].id,
                0,
                false,
            );
        }
    }
    changed(app, None);
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
             Your own notices are listed first. **STALE** means neither the notice nor \
             its card has said anything for hours — a real doubt rather than a \
             timestamp. If it is yours, re-`post` it to say it is still true or \
             `unpost` it. If it is somebody else's and their card is dormant, `unpost` \
             can offer to retire it; after three days the wall does it unasked.",
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
            "Take a notice off the billboard, because it is no longer true. Do this to \
             your own as soon as the work it describes is done — it is the half of the \
             billboard that makes the other half worth reading.\n\n\
             Name it by its `subject` or by the id `board` reports, or pass \
             `all: true` to clear everything you have up, which is what to do when you \
             finish a piece of work.\n\n\
             **You may also name somebody else's notice, and what happens depends on \
             whether anybody is behind it.** A live card's notice is a claim it is still \
             making, so yours is refused — `mcp__skein__send` it and ask, or \
             `mcp__skein__close` it if it has plainly finished, which retires everything \
             it had up. A notice whose card is dormant and has been quiet for hours is a \
             claim on behalf of nobody: naming one parks this call and puts it to the \
             user. That is the move for a card that died mid-turn and will never wake. \
             Do not use it to clear a board you have not read — every ask spends the \
             user's attention, and after three days a notice comes down by itself.",
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
    sweep(app);
    let store = app.state::<Store>();
    let Ok(conn) = store.0.lock() else {
        return "the store is unavailable".into();
    };
    let scope = if all { None } else { me.project_id.as_deref() };
    let notices = match crate::store::notices(&conn, scope) {
        Ok(n) => n,
        Err(e) => return format!("could not read the board: {e}"),
    };
    let seen = seen_map(&conn);
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
            "Yours, still up — take any of these down with `mcp__skein__unpost` once they \
             are no longer true:\n\n",
        );
        for n in &mine {
            out.push_str(&render(n, &seen, now));
        }
        out.push('\n');
    }
    if theirs.is_empty() {
        out.push_str("Nobody else has anything up.");
    } else {
        out.push_str("From the other conversations on this wall:\n\n");
        for n in &theirs {
            out.push_str(&render(n, &seen, now));
        }
    }
    out
}

fn render(n: &Notice, seen: &HashMap<String, i64>, now: i64) -> String {
    let who = match &n.from_id {
        Some(id) => crate::relay::handle_of(id),
        None => "the user".into(),
    };
    let age = ago(now - n.posted_at);
    let mark = if stale(n, seen_of(seen, n), now) {
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
fn yours(mine: &[&Notice], seen: &HashMap<String, i64>, now: i64) -> String {
    let mut rows: Vec<&&Notice> = mine.iter().collect();
    rows.sort_by_key(|n| (!stale(n, seen_of(seen, n), now), n.touched_at));
    rows.iter()
        .map(|n| {
            let globs = globs_of(n);
            format!(
                "  - {:?} — untouched {}{} — {}\n",
                n.subject,
                ago(now - n.touched_at),
                if stale(n, seen_of(seen, n), now) { ", STALE" } else { "" },
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
fn refuse_full(mine: &[&Notice], paths: &str, seen: &HashMap<String, i64>, now: i64) -> String {
    format!(
        "this card already has {MAX_PER_CARD} notices up, which is the limit. {}\n\n\
         Take one down with `mcp__skein__unpost` and post this again — or post it under a \
         subject you already have up, which replaces that notice rather than \
         adding one and costs nothing. Yours, likeliest-finished first:\n{}",
        at_stake(paths),
        yours(mine, seen, now),
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
fn refuse_bare(bare: &[&Notice], seen: &HashMap<String, i64>, now: i64) -> String {
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
         Otherwise take one of these down with `mcp__skein__unpost` — yours with no files \
         named, likeliest-finished first:\n{}",
        at_stake(""),
        yours(bare, seen, now),
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
    let globs = globs_from(args.get("paths"));
    if globs.len() > MAX_GLOBS {
        return refuse_globs(&globs);
    }
    let paths = globs.join("\n");
    let skein = args.get("scope").and_then(Value::as_str) == Some("skein");
    let project_id = if skein { None } else { me.project_id.clone() };
    if !skein && project_id.is_none() {
        return "this card is not on the wall, so it has no project board to post to".into();
    }

    /* Counted after the sweep, or a card whose old notices died with a closed
       colleague — or expired while it was away — would be refused against a
       board that no longer exists. */
    sweep(app);
    let store = app.state::<Store>();
    let Ok(conn) = store.0.lock() else {
        return "the store is unavailable".into();
    };
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
        let seen = seen_map(&conn);
        /* The total first, and the order matters. The unpathed refusal below
           tells the agent that adding `paths` would let this through, and that
           is only true while there is room under the total — offering it at
           eight would be a way forward that does not work, which is the failure
           this whole change is about wearing a friendlier face. */
        if mine.len() >= MAX_PER_CARD {
            let refusal = refuse_full(&mine, &paths, &seen, now);
            drop(conn);
            return refusal;
        }
        let bare: Vec<&Notice> = mine
            .iter()
            .copied()
            .filter(|n| globs_of(n).is_empty())
            .collect();
        if paths.is_empty() && bare.len() >= MAX_UNPATHED {
            let refusal = refuse_bare(&bare, &seen, now);
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
                 `mcp__skein__unpost` as soon as it is no longer true — a notice left up \
                 after the work is done stops somebody else for no reason.",
                if skein { "wall-wide" } else { "project" },
                lost(&subject, subject_cut, &body, body_cut),
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
///
/// **Prose only.** It used to report dropped globs here as well, and that was
/// the whole of the guard for them — a line on a receipt for a call that
/// succeeded. `refuse_globs` says why that could not work and what replaced it;
/// nothing silently drops a glob any more, so there is nothing left for this to
/// say about them.
fn lost(subject: &str, subject_cut: usize, body: &str, body_cut: usize) -> String {
    let mut out = String::new();
    if subject_cut > 0 {
        out.push_str(&format!(
            " The subject was {subject_cut} characters over the {MAX_SUBJECT} a subject \
             may be and now reads {subject:?} — check that is still the subject you \
             would `mcp__skein__unpost` by."
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

/* -- taking down somebody else's ------------------------------------------
 *
 * `unpost` was poster-only for its whole first life, and the rule is right
 * about a *live* card: its notice is a claim it is still making, and a colleague
 * deciding on its behalf that the work is finished is a colleague guessing.
 *
 * What that rule had no answer for is a card that will never speak again. A
 * card killed mid-turn does not wake, a dormant one only unposts if the user
 * happens to open it, and a `send` to either is queued rather than delivered —
 * so its notice was **structurally immortal**, and the notices that accumulate
 * are exactly the wrong ones: a card that finishes cleanly tends to unpost,
 * where one that dies leaves its hold up for ever. A board cleanup on
 * 2026-09-13 found fifteen notices on the nova wall of which twelve were stale,
 * and the only move anybody found was to *close* the card (sink `b5453473`).
 *
 * Two things changed and they are meant to be read together. `EXPIRE_AFTER_MS`
 * takes such a notice down on its own after three days and needs nobody to
 * decide anything. This is the same move made *now*, for the window before
 * that, and it needs somebody to decide — so it asks, the way `close` asks,
 * because the question is not one this file can answer.
 *
 * **Why it asks rather than simply doing it, when the conditions look
 * conclusive.** A card that died mid-turn did not tidy up after itself: its
 * half-written edits are still in the shared tree, and its notice is the only
 * thing telling anybody to leave them alone. That is the precise shape of the
 * 2026-08-27 incident — a claim that was not made, a sibling committing the
 * file with an explicit pathspec, and a hundred lines of somebody else's work
 * under the wrong message. Nothing here can tell the tidy death from the messy
 * one; a person looking at the wall can. So the two provable facts (no process,
 * and nothing said for `STALE_AFTER_MS`) decide whether it is worth *asking*,
 * and the person decides.
 */

/// Whether a notice is somebody else's to take down, and what to say if not.
///
/// Pure over the two facts, so the rule can be asserted rather than reached
/// through a live wall. `has_process` is the supervisor's answer and `quiet` is
/// `quiet_ms` — a card with neither is one nothing can be asked of.
fn retirable(has_process: bool, quiet: i64) -> bool {
    !has_process && quiet > STALE_AFTER_MS
}

/// The refusal for a notice whose card is still there to be asked.
///
/// The poster-only rule with its reasoning attached, and — the part that was
/// missing — the two things that *do* work, so an agent that has found a stale
/// notice is not left where the last one was, which is with nothing to try.
fn still_theirs(subject: &str, who: &str, title: &str, live: bool, quiet: i64) -> String {
    format!(
        "{subject:?} is {title:?}'s notice ({who}), not yours, so it is not yours to \
         take down. {}\n\n\
         A notice is a claim the card that posted it is still making, and that card is \
         the one thing that knows whether it still is. Two things that do work: \
         `mcp__skein__send` it and ask — a dormant card is woken to read a message \
         addressed to it — or, if it has plainly finished, `mcp__skein__close` it, \
         which retires \
         everything it has up. And if nobody is ever behind it again, the wall takes it \
         down by itself once it and its card have been silent for three days.",
        if live {
            format!("It has a process and has been quiet {}.", ago(quiet))
        } else {
            format!(
                "It is dormant and has been quiet {} — not yet long enough for this card \
                 to offer to retire it on its behalf, which needs {}.",
                ago(quiet),
                ago(STALE_AFTER_MS),
            )
        },
    )
}

/// What goes up when a card offers to retire a dead card's claim.
///
/// It carries the one fact that makes the question answerable and that nothing
/// on this side can work out: **what the notice was holding**. A person who can
/// see that it claimed `store.rs` and that the card died part-way through a
/// migration will say no; the same person shown only two titles has been handed
/// a decision with the evidence left out, which is the thing `close`'s own
/// refusals are written to avoid.
fn retire_question(subject: &str, body: &str, globs: &[&str], title: &str, handle: &str, by: &str, quiet: i64) -> Value {
    let holding = if globs.is_empty() {
        "It names no files, so nothing is being unclaimed by taking it down — it is an \
         announcement nobody is making any more."
            .to_string()
    } else {
        format!(
            "It is claiming {} — cards editing those are being told to leave them alone, \
             and that stops.",
            globs.join(", ")
        )
    };
    json!({
        "questions": [{
            "header": "retire a notice",
            "question": format!(
                "{by:?} wants to take {title:?}'s billboard notice off the wall.\n\n\
                 **{subject}**\n\n{body}\n\n\
                 {title:?} ({handle}) has no process and nothing has been said on this \
                 notice's behalf for {}. {holding}\n\n\
                 The card itself is untouched — this takes down the notice and nothing \
                 else. Worth knowing before you answer: a card that died part-way \
                 through still has its half-finished edits in the tree, and a notice \
                 like this one is the only thing telling anybody to leave them alone.",
                ago(quiet),
            ),
            "options": [
                { "label": RETIRE_IT, "detail": "Take the notice down. The card stays as it is." },
                { "label": KEEP_IT, "detail": "It stays up. The agent is told you said so." }
            ]
        }]
    })
}

const RETIRE_IT: &str = "take it down";
const KEEP_IT: &str = "leave it up";

/// Exact, and nothing looser, for `spawn::approved`'s reason: the panel has a
/// free-text field beside the buttons, and reading a yes out of prose is a thing
/// that works until "yes, but ask it first".
fn agreed(answer: &str) -> bool {
    answer.trim().eq_ignore_ascii_case(RETIRE_IT)
}

/// What a `unpost` turns out to be — `spawn::Closing`'s shape, one tool over.
pub(crate) enum Unposting {
    /// Answer the tool call with this, now.
    Now(String),
    /// Put this question up and wait.
    Ask {
        question: Value,
        settle: crate::ask::Settle,
    },
}

/// The `unpost` tool, as far as it can be decided without a person.
///
/// Called from `ask.rs` directly rather than through `handle`, for the reason
/// `spawn::close` is: the decision has to be taken before the transport commits
/// to answering on the spot, and it must be taken once.
pub(crate) fn unpost(app: &AppHandle, caller: &str, args: &Value) -> Unposting {
    sweep(app);
    let store = app.state::<Store>();
    let me = reader(app, caller);
    let Ok(conn) = store.0.lock() else {
        return Unposting::Now("the store is unavailable".into());
    };

    if args.get("all").and_then(Value::as_bool) == Some(true) {
        let n = crate::store::drop_notices_of(&conn, caller);
        drop(conn);
        changed(app, me.project_id);
        return Unposting::Now(match n {
            0 => "you had nothing up.".into(),
            1 => "took your notice down.".into(),
            n => format!("took all {n} of your notices down."),
        });
    }

    let Some(want) = args.get("subject").and_then(Value::as_str).map(str::trim) else {
        return Unposting::Now(
            "name the notice by its subject or its id, or pass `all: true`".into(),
        );
    };
    let all = crate::store::notices(&conn, None).unwrap_or_default();
    let mine: Vec<&Notice> = all
        .iter()
        .filter(|n| n.from_id.as_deref() == Some(caller))
        .collect();

    if let Some(n) = resolve(&mine, want) {
        let subject = n.subject.clone();
        let gone = crate::store::drop_notice(&conn, &n.id, Some(caller));
        drop(conn);
        return Unposting::Now(if gone {
            changed(app, me.project_id);
            format!("took {subject:?} down.")
        } else {
            format!("{subject:?} was already gone.")
        });
    }

    /* Not one of yours. **The old answer here was "you have no notices up",
       and it was a lie of the worst available kind** — it read as "there is
       nothing of yours on the board" where what had actually happened was "that
       is not yours", so an agent that had correctly found a stale notice and
       correctly tried to take it down was told, in effect, that it had imagined
       it. The two are separated now, and the cross-card case is answered rather
       than swallowed. */
    let theirs: Vec<&Notice> = all
        .iter()
        .filter(|n| n.from_id.as_deref() != Some(caller))
        .collect();
    let Some(n) = resolve(&theirs, want) else {
        drop(conn);
        return Unposting::Now(nothing_called(want, &mine));
    };

    let now = crate::store::now();
    let seen = seen_map(&conn);
    let quiet = quiet_ms(n, seen_of(&seen, n), now);
    let Some(from) = n.from_id.clone() else {
        drop(conn);
        return Unposting::Now(format!(
            "{:?} is the user's own notice, not a card's — nothing on this wall posted \
             it and no card may take it down. It is theirs to remove from the billboard \
             widget. If it has stopped being true, say so in your reply.",
            n.subject
        ));
    };
    let card = crate::store::roster_one(&conn, &from);
    drop(conn);

    let title = card
        .as_ref()
        .map(|r| r.title.clone())
        .unwrap_or_else(|| format!("card {}", crate::relay::handle_of(&from)));
    let has_process = app
        .state::<crate::supervisor::Supervisor>()
        .liveness(&from)
        .0;
    if !retirable(has_process, quiet) {
        return Unposting::Now(still_theirs(
            &n.subject,
            &crate::relay::handle_of(&from),
            &title,
            has_process,
            quiet,
        ));
    }

    let by = reader_title(app, caller);
    let question = retire_question(
        &n.subject,
        &n.body,
        &globs_of(n),
        &title,
        &crate::relay::handle_of(&from),
        &by,
        quiet,
    );
    let id = n.id.clone();
    let subject = n.subject.clone();
    Unposting::Ask {
        question,
        settle: Box::new(move |app, answer| {
            let Some(answer) = answer else {
                return format!(
                    "nobody answered, so {subject:?} stays up. Either the question stood \
                     for ten minutes or this card was dismissed while it was up. Carry \
                     on with your own judgement about the files it names, and say that \
                     you offered to retire it."
                );
            };
            if !agreed(answer) {
                let said = answer.trim();
                if said.eq_ignore_ascii_case(KEEP_IT) {
                    return format!(
                        "the user was asked and said to leave {subject:?} up, so it \
                         stays. That is an answer rather than this tool refusing you — \
                         treat the claim as live, do not ask again about the same \
                         notice, and say in your reply that you offered."
                    );
                }
                return format!(
                    "the user was asked about {subject:?} and answered {said:?} rather \
                     than taking it down, so it stays up. Act on what they said."
                );
            }
            /* Approved — and now read the wall again rather than acting on what
               it said ten minutes ago. The card may have woken and be working
               under that claim by now, which is exactly the state the two
               conditions were checked against. */
            let Some(store) = app.try_state::<Store>() else {
                return "the user approved it, but the store is unavailable.".into();
            };
            let still = {
                let Ok(conn) = store.0.lock() else {
                    return "the user approved it, but the store is unavailable.".into();
                };
                crate::store::notices(&conn, None)
                    .unwrap_or_default()
                    .into_iter()
                    .find(|n| n.id == id)
            };
            let Some(fresh) = still else {
                return format!(
                    "the user approved it, but {subject:?} is no longer on the board — \
                     it went while the question was up. Nothing to do."
                );
            };
            let Some(from) = fresh.from_id.clone() else {
                return format!("the user approved it, but {subject:?} has changed hands.");
            };
            let woke = app
                .state::<crate::supervisor::Supervisor>()
                .liveness(&from)
                .0;
            if woke {
                return format!(
                    "the user approved it, but the card that posted {subject:?} has woken \
                     since the question went up, so the notice is a claim somebody is \
                     making again and it stays. `mcp__skein__send` it if you need that \
                     settled."
                );
            }
            let gone = {
                let Ok(conn) = store.0.lock() else {
                    return "the user approved it, but the store is unavailable.".into();
                };
                crate::store::drop_notice(&conn, &fresh.id, None)
            };
            changed(app, None);
            if gone {
                format!(
                    "the user approved it — {subject:?} is off the board. It was not \
                     yours, so say in your reply that you asked and they agreed, and \
                     that the files it named are now unclaimed."
                )
            } else {
                format!("{subject:?} was already gone.")
            }
        }),
    }
}

/// Which notice a written name means.
///
/// Id first, then the exact subject, then the id's short head — the same ladder
/// `relay::resolve` walks, and for the same reason: the agent was given both
/// spellings and either is a fair thing to type back.
fn resolve<'a>(rows: &[&'a Notice], want: &str) -> Option<&'a Notice> {
    rows.iter()
        .find(|n| n.id == want)
        .or_else(|| rows.iter().find(|n| n.subject.eq_ignore_ascii_case(want)))
        .or_else(|| rows.iter().find(|n| n.id.starts_with(want) && want.len() >= 4))
        .copied()
}

/// Nothing anywhere on the board answers to that name.
///
/// Says which of the two things happened — nothing of yours, or nothing at all —
/// because the old message said the first about both and sent agents looking for
/// a board that was not there.
fn nothing_called(want: &str, mine: &[&Notice]) -> String {
    if mine.is_empty() {
        return format!(
            "no notice anywhere on the board is called {want:?}, and you have none up \
             yourself. `mcp__skein__board` is the list — a notice is named by its \
             subject or by the id in square brackets beside it."
        );
    }
    format!(
        "no notice called {want:?} — not one of yours and not one of anybody's. Yours \
         are: {}. `mcp__skein__board` has the rest of the wall's.",
        mine.iter()
            .map(|n| format!("{:?}", n.subject))
            .collect::<Vec<_>>()
            .join(", ")
    )
}

/// What the *caller* is called, for a question that is about two cards at once.
///
/// A handle would be correct and unreadable: the whole difficulty of the
/// question is that one of the two cards in it is the one the user is looking
/// at. Same reasoning as `spawn::close`'s `by`.
fn reader_title(app: &AppHandle, caller: &str) -> String {
    app.state::<Store>()
        .0
        .lock()
        .ok()
        .and_then(|conn| crate::store::roster_one(&conn, caller))
        .map(|r| r.title)
        .unwrap_or_else(|| format!("card {}", crate::relay::handle_of(caller)))
}

/// Turn whatever the model wrote into a list of globs — **all of them**.
///
/// It used to cap here and hand back a count of what it had thrown away, and
/// that was the wrong place for the decision to live: a function that has
/// already dropped the excess leaves its caller nothing to refuse *with*, so
/// the only thing left to do with the count was mention it on a receipt. See
/// `refuse_globs` for why a receipt was not enough. Whether a list is too long
/// is the caller's question; this one only parses.
fn globs_from(v: Option<&Value>) -> Vec<String> {
    match v {
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
    }
}

/// Too many globs for one notice, and which ones to keep.
///
/// **The only cap on this server that refuses rather than trims, and the
/// asymmetry is the whole of the item.** Everywhere else a cap is reached, what
/// is lost is the tail of some *prose* — a sentence off a body, a few words off
/// a subject — and `clip` cuts it, marks it in the text, and says on the receipt
/// how much went. That bargain works because the reader can see something is
/// missing and the writer is handed a number.
///
/// A dropped glob is not prose. It is a **claim that silently does not exist**,
/// and nothing downstream can notice: the notice goes up, the board reads as
/// though the work had been announced, no card writing to the unclaimed file is
/// ever served anything, and neither side ever finds out. A receipt is the only
/// place it could be said, and a receipt on a call that *succeeded* is read as a
/// formality — which is exactly what happened. Card 5c42088c posted eleven globs
/// before starting a multi-file feature, was told in good prose that three had
/// been dropped, and carried on; the three were `store.rs` (a schema migration),
/// `mcp.rs` and `package.json`, which were the three most collision-prone files
/// it had named (sink `b2b28f42`). It reproduced on this wall the day the item
/// was worked — thirteen globs, five dropped — and the well-written receipt let
/// a wrong notice stand a second time.
///
/// That the tail is where the risk lives is not a coincidence to engineer
/// around: **people list files in the order they will touch them**, so the scary
/// one is last. Keeping the last `MAX_GLOBS` rather than the first was on the
/// table and is the wrong shape of fix — it moves the silent loss somewhere
/// safer instead of making it stop being silent.
///
/// So this refuses, and it hands back the two lists already split, because a way
/// forward has to be actionable without a second call — the same rule `yours` is
/// written to.
fn refuse_globs(globs: &[String]) -> String {
    let (keep, rest) = globs.split_at(MAX_GLOBS);
    format!(
        "nothing was posted: this notice names {} globs, and one notice watches \
         {MAX_GLOBS}.\n\n\
         **It is refused rather than trimmed, on purpose.** A glob past the limit is \
         not a shortened sentence — it is a claim that does not exist, on a notice that \
         went up looking complete. Nobody editing that file would be told anything, the \
         board would read as though the work had been announced, and neither card would \
         ever learn why no notice arrived. There is nothing downstream of this to catch \
         that, so it is caught here.\n\n\
         Post it again with these {MAX_GLOBS}:\n\n  {}\n\n\
         and, if the rest still need claiming, a second notice under a different \
         subject for:\n\n  {}\n\n\
         Or fold several into one pattern — `src/lib/**` claims a whole directory in a \
         single glob, and a card taking over a module is usually saying that anyway.",
        globs.len(),
        keep.join("\n  "),
        rest.join("\n  "),
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
/// Kept for its two callers' shape — `(text, overflow)` — over the shared
/// clipper, which does the cutting.
///
/// The board got the *writer's* half of this right before anywhere else did:
/// `do_post`'s receipt names how many characters were over, which is why the two
/// call sites want a count rather than a `Cut`. What it did not do was cut at a
/// boundary or leave any mark in the text a card would later be *served* — so a
/// notice went up with its tail gone and only the poster ever knew. `crate::clip`
/// supplies both halves now; this wrapper just keeps the tuple.
fn clip(s: &str, max: usize) -> (String, usize) {
    let cut = crate::clip::keep(s, max);
    let text = cut.marked(
        "The notice was longer than a notice may be. If you need the whole of it, ask the \
         card that posted it with `mcp__skein__send` — it still has what it wrote.",
    );
    (text, cut.omitted)
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
    /* Before the candidates, not after: this is the one reading of the board
       that happens without anybody asking for it, and serving a card a claim
       that expired days ago is the whole of what `86e0f8b0` was filed about. */
    sweep(app);

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

fn as_json(n: &Notice, seen: &HashMap<String, i64>, now: i64) -> Value {
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
        "stale": stale(n, seen_of(seen, n), now),
    })
}

#[tauri::command]
pub fn read_board(app: AppHandle, project_id: Option<String>) -> Result<Value, String> {
    sweep(&app);
    let store = app.state::<Store>();
    let conn = store.0.lock().map_err(|_| "the store is unavailable")?;
    let notices = crate::store::notices(&conn, project_id.as_deref())?;
    let seen = seen_map(&conn);
    let now = crate::store::now();
    Ok(json!(notices.iter().map(|n| as_json(n, &seen, now)).collect::<Vec<_>>()))
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
    let globs = globs_from(paths.map(|p| json!(p)).as_ref());
    let globs_over = globs.len().saturating_sub(MAX_GLOBS);
    let globs = globs.join("\n");
    /* **Refused where a card's is clipped, and the asymmetry is the point.** An
       agent's post costs a turn, so cutting the tail and saying so on the
       receipt is the cheaper of two bad outcomes — see `clip`. Yours costs a
       keystroke: the text is still in the field in front of you, `Board.fault`
       already draws what came back, and shortening it is a moment's work. So
       nothing of yours goes up truncated. The rule under both is one rule —
       never silently keep less than was written. */
    if subject_cut > 0 || body_cut > 0 || globs_over > 0 {
        let mut over: Vec<String> = Vec::new();
        if subject_cut > 0 {
            over.push(format!("the subject is {subject_cut} over {MAX_SUBJECT}"));
        }
        if body_cut > 0 {
            over.push(format!("the body is {body_cut} over {MAX_BODY}"));
        }
        if globs_over > 0 {
            over.push(format!("{globs_over} globs past the {MAX_GLOBS} a notice carries"));
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
        /* The control surface cannot park, and must not pretend the answer was
           a refusal either — a test that saw "it stays up" would be reading a
           decision nobody made. So the question is handed back as the answer,
           which is exactly what the wall would have put in front of the user. */
        match unpost(&app, &id, &args) {
            Unposting::Now(said) => said,
            Unposting::Ask { question, .. } => format!(
                "asks: {}",
                question["questions"][0]["question"]
                    .as_str()
                    .unwrap_or("")
            ),
        }
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
        /* `unpost` is deliberately **not** here. It is the third tool on this
           server that can end in a question, so `ask.rs` calls `unpost` before
           this chain — which has already committed to answering on the spot.
           Taking down one of your own still answers at once; only a dead card's
           notice parks. */
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Nobody on the wall has taken a turn — so every notice's clock is its own
    /// `touched_at`, which is the reading the board had before `quiet_ms`.
    fn nobody() -> HashMap<String, i64> {
        HashMap::new()
    }

    /// The notice's author last finished a turn at `at`.
    fn heard(at: i64) -> HashMap<String, i64> {
        HashMap::from([(AUTHOR.to_string(), at)])
    }

    const AUTHOR: &str = "aaaaaaaa-1111-4111-8111-111111111111";

    fn notice(paths: &str, touched: i64) -> Notice {
        Notice {
            id: "n1".into(),
            scope: "project".into(),
            project_id: Some("skein".into()),
            from_id: Some(AUTHOR.into()),
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
    fn globs_arrive_as_a_string_or_a_list_and_none_are_dropped_here() {
        assert_eq!(globs_from(Some(&json!("a.rs, b.rs"))), vec!["a.rs", "b.rs"]);
        assert_eq!(globs_from(Some(&json!(["a.rs", " b.rs "]))), vec!["a.rs", "b.rs"]);
        assert!(globs_from(None).is_empty());
        /* **The whole list comes back, cap or no cap.** It used to truncate
           here and hand back a count, which left the caller nothing to refuse
           with — so the only thing that could be done about the excess was to
           mention it on a receipt for a call that had succeeded. See
           `refuse_globs`. */
        let many: Vec<String> = (0..30).map(|i| format!("f{i}.rs")).collect();
        assert_eq!(globs_from(Some(&json!(many))).len(), 30);
    }

    /// **The item.** A dropped glob is a claim that silently does not exist, on
    /// a notice that went up looking complete — so this refuses, and the refusal
    /// has to be usable in one move rather than sending the caller back to think.
    #[test]
    fn too_many_globs_is_refused_and_hands_back_both_halves() {
        let globs: Vec<String> = (0..MAX_GLOBS + 3).map(|i| format!("f{i}.rs")).collect();
        let out = refuse_globs(&globs);
        assert!(out.starts_with("nothing was posted"), "{out}");
        assert!(out.contains(&format!("{} globs", MAX_GLOBS + 3)));
        /* Both lists, named. The ones to keep and the ones that still want a
           notice — an agent given only a number has to work the split out. */
        assert!(out.contains("f0.rs") && out.contains(&format!("f{}.rs", MAX_GLOBS - 1)));
        assert!(out.contains(&format!("f{}.rs", MAX_GLOBS + 2)));
        /* And why it is a refusal rather than a trim, since that is the whole
           of what changed and an agent that reads it as a quota will retry. */
        assert!(out.contains("refused rather than trimmed"));
        assert!(out.contains("claim that does not exist"));
    }

    /// Raised with the refusal and not instead of it. Eight was set against no
    /// measurement and the honest lists people write are longer.
    #[test]
    fn a_notice_watches_more_globs_than_a_card_has_notices() {
        assert!(MAX_GLOBS > MAX_PER_CARD);
        assert_eq!(MAX_GLOBS, 12);
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

        /* A run of `x` has no boundary in it, so the text is cut on the cap and
           the marker follows it. The overflow count is what `do_post`'s receipt
           reports and is the half the board always got right. */
        let long = "x".repeat(50);
        let (kept, cut) = clip(&long, 40);
        assert_eq!(cut, 10);
        assert_eq!(kept.matches('x').count(), 40);
        assert!(kept.contains("clipped by the wall"), "{kept}");
        assert!(kept.contains("10 of 50 characters"), "{kept}");

        /* Characters, not bytes — the cut must not land inside a code point. */
        let wide = "é".repeat(50);
        let (kept, cut) = clip(&wide, 40);
        assert_eq!(kept.matches('é').count(), 40);
        assert_eq!(cut, 10);

        /* And the reader is now told, which is the half that was missing: a
           notice served to a card used to end mid-sentence with only its poster
           knowing. */
        assert!(kept.contains("`mcp__skein__send`"), "no way to ask for the rest: {kept}");
    }

    #[test]
    fn a_receipt_is_silent_about_what_fitted_and_loud_about_what_did_not() {
        assert_eq!(lost("s", 0, "b", 0), "");
        let body = "the whole protocol, ending here and cut after this point";
        let out = lost("s", 0, body, 300);
        assert!(out.contains("300 characters were cut"));
        /* Where it stopped, so the agent can see what it lost without diffing
           the board against its own draft. */
        assert!(out.contains("cut after this point"));
        assert!(out.contains(&format!("{}", MAX_BODY + 300)));
        assert!(lost("looong", 12, "b", 0).contains("12 characters over"));
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

        let out = yours(&mine, &nobody(), now);
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
        let out = refuse_full(&mine, "src-tauri/src/hooks.rs", &nobody(), now);
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
        let out = refuse_bare(&bare, &nobody(), 0);
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
        assert!(stale(&notice("", 0), None, now));
        assert!(!stale(&notice("", now - 60_000), None, now));
    }

    /// **The mark is about the card, not only about the notice**, and that is
    /// what stopped it firing on everything. Nobody re-posts a notice every hour
    /// to say they are still typing, so an author's turn is evidence for the
    /// claim exactly as re-posting is — and without it a board cleanup found
    /// fifteen notices of which every one, two hours old included, was labelled
    /// STALE (sink `b5453473`).
    #[test]
    fn an_author_still_taking_turns_keeps_its_notice_fresh() {
        let now = STALE_AFTER_MS * 3;
        let old = notice("store.rs", now - STALE_AFTER_MS * 2);

        /* The notice alone says stale, and on its own that was the old answer. */
        assert!(stale(&old, None, now));
        /* The card answered a minute ago, so somebody is behind it. */
        assert!(!stale(&old, Some(now - 60_000), now));
        /* And a card that has also been quiet does not rescue it. */
        assert!(stale(&old, Some(now - STALE_AFTER_MS * 2), now));
        /* Neither clock may run backwards: the later of the two is the reading,
           so an author heard from *before* the notice was touched changes
           nothing. */
        let fresh = notice("store.rs", now - 60_000);
        assert!(!stale(&fresh, Some(now - STALE_AFTER_MS * 9), now));
    }

    /// The clearing that reaches a notice nobody else can. A card killed
    /// mid-turn never unposts, never wakes to be asked, and `unpost` was
    /// poster-only — so before this its hold stood for ever (sink `86e0f8b0`:
    /// fourteen days over three of the most-edited files in `rise`).
    #[test]
    fn a_notice_nobody_has_been_behind_for_days_expires() {
        let now = EXPIRE_AFTER_MS * 2;
        let dead = notice("ticket.ts", now - EXPIRE_AFTER_MS - 1);
        assert!(expired(&dead, None, now));
        /* Stale comes first and by a long way — the mark is a doubt, the expiry
           is a decision, and a notice must be readable as doubtful for days
           before anything takes it down. */
        assert!(stale(&dead, None, now));
        assert!(EXPIRE_AFTER_MS > STALE_AFTER_MS * 8);
        /* An author that has taken a turn inside the window keeps it, by the
           same rule that keeps it off the stale list. */
        assert!(!expired(&dead, Some(now - 60_000), now));
        /* And a weekend is not an expiry: Friday evening to Monday morning is
           about sixty-four hours, and a claim that cannot survive one is a claim
           nobody will trust with a piece of work that takes one. */
        assert!(!expired(&notice("", now - 64 * 60 * 60 * 1_000), None, now));
    }

    /// A notice is deleted rather than archived, so this is the whole of what
    /// survives it — which is why it names the subject and the files rather
    /// than a count. The card is being asked one question and can only answer
    /// it if it is told what "this" was.
    #[test]
    fn an_expired_notice_tells_its_author_what_it_was_claiming() {
        let a = subject("approvals phase 4b", "ticket.ts\napproval.ts", 0);
        let b = subject("a passing thought", "", 0);
        let out = expiry_note(&[a, b], EXPIRE_AFTER_MS);
        assert!(out.contains("2 of your billboard notices"));
        assert!(out.contains("approvals phase 4b"));
        assert!(out.contains("ticket.ts, approval.ts"));
        /* A notice that named no files says nothing about claiming any. */
        assert!(out.contains("a passing thought"));
        /* The one move, said in one call. */
        assert!(out.contains("mcp__skein__post"));
        /* And it must not read as a chore: a dormant card woken to find a job
           at the top of its transcript is the cost `b5453473` complains about,
           not the fix. */
        assert!(out.contains("nothing to do and nothing to reply to"));
    }

    #[test]
    fn the_reading_names_the_notice_its_author_and_its_files() {
        let out = render(&notice("src/lib/*.ts\nstore.rs", 0), &nobody(), 0);
        assert!(out.contains("reworking the store"));
        assert!(out.contains("aaaaaaaa"));
        assert!(out.contains("src/lib/*.ts, store.rs"));
        assert!(!out.contains("STALE"));
        assert!(render(&notice("", 0), &nobody(), STALE_AFTER_MS * 2).contains("STALE"));
        /* Off the same number the wall draws, and off the author's clock too:
           a card heard from just now has no stale notices. */
        assert!(!render(&notice("", 0), &heard(STALE_AFTER_MS * 2), STALE_AFTER_MS * 2)
            .contains("STALE"));
    }

    /* ── taking down somebody else's ────────────────────────────────────────
     *
     * The poster-only rule was right about a live card and had no answer for a
     * dead one, so the two are now separated by two provable facts and the
     * person decides between them.
     */

    #[test]
    fn only_a_card_that_is_not_there_may_be_offered_up() {
        /* A live card's notice is a claim it is still making, however long it
           has been up — the card is there to be asked. */
        assert!(!retirable(true, EXPIRE_AFTER_MS * 10));
        /* A dormant one that has only just gone quiet is not offered either:
           dormancy alone is the ordinary state of most of the wall. */
        assert!(!retirable(false, STALE_AFTER_MS / 2));
        /* Both together, which is the pair `86e0f8b0` proposes. */
        assert!(retirable(false, STALE_AFTER_MS + 1));
    }

    #[test]
    fn a_live_cards_notice_is_refused_with_the_two_things_that_do_work() {
        let out = still_theirs("the store schema", "ab12cd34", "the migration", true, 60_000);
        assert!(out.contains("not yours"));
        assert!(out.contains("the migration"));
        /* The gap this whole item is about: the old answer named no way out at
           all, so an agent that had correctly found a stale notice was left
           where the last one was. */
        assert!(out.contains("mcp__skein__send"));
        assert!(out.contains("mcp__skein__close"));
        /* And the one that needs nobody: it comes down by itself eventually. */
        assert!(out.contains("three days"));
        /* A dormant card that has not been quiet long enough says why, rather
           than reading as the same flat no. */
        let soon = still_theirs("the store schema", "ab12cd34", "the migration", false, 60_000);
        assert!(soon.contains("dormant"));
    }

    /// **The old answer was "you have no notices up", and that is a lie of the
    /// worst available kind** — it reads as "there is nothing of yours on the
    /// board" where what happened is "that is not yours".
    #[test]
    fn a_name_that_matches_nothing_says_which_of_the_two_it_was() {
        let held = subject("holding the panel", "Transcript.svelte", 0);
        let mine: Vec<&Notice> = vec![&held];
        let out = nothing_called("the store schema", &mine);
        assert!(out.contains("not one of yours and not one of anybody's"));
        assert!(out.contains("holding the panel"));

        let none = nothing_called("the store schema", &[]);
        assert!(none.contains("no notice anywhere on the board"));
        assert!(none.contains("you have none up yourself"));
    }

    /// The question carries the one fact nothing on this side can work out —
    /// what the notice was holding — because a person shown only two titles has
    /// been handed a decision with the evidence left out.
    #[test]
    fn the_question_says_what_is_being_unclaimed_and_what_that_risks() {
        let q = retire_question(
            "MINE while this runs",
            "preview-router is being rebuilt, leave it alone",
            &["preview-router/**", "web.config"],
            "the preview router",
            "85071001",
            "the board sweep",
            EXPIRE_AFTER_MS,
        );
        let text = q["questions"][0]["question"].as_str().unwrap();
        assert!(text.contains("the board sweep"));
        assert!(text.contains("the preview router"));
        assert!(text.contains("85071001"));
        /* What is being unclaimed, by name. */
        assert!(text.contains("preview-router/**, web.config"));
        /* The reason this is a question rather than a rule: a card that died
           part-way through still has its edits in the shared tree. */
        assert!(text.contains("half-finished edits"));
        /* And that nothing happens to the card itself. */
        assert!(text.contains("card itself is untouched"));
        assert_eq!(q["questions"][0]["options"][0]["label"], RETIRE_IT);
        assert_eq!(q["questions"][0]["options"][1]["label"], KEEP_IT);

        /* A notice naming no files is not described as unclaiming any. */
        let bare = retire_question("a thought", "b", &[], "t", "h", "by", 0);
        let text = bare["questions"][0]["question"].as_str().unwrap();
        assert!(text.contains("names no files"));
    }

    /// Exact, for `spawn::approved`'s reason: the panel has a free-text field
    /// beside the buttons, and reading a yes out of prose is a thing that works
    /// until it does not.
    #[test]
    fn only_the_button_agrees() {
        assert!(agreed(RETIRE_IT));
        assert!(agreed("  Take It Down "));
        assert!(!agreed(KEEP_IT));
        assert!(!agreed("yes, but ask it first"));
        assert!(!agreed(""));
    }

    #[test]
    fn a_notice_you_posted_says_so_rather_than_naming_a_card() {
        let mut n = notice("", 0);
        n.from_id = None;
        assert!(render(&n, &nobody(), 0).contains("the user"));
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
