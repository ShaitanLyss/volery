//! The sink: what an agent noticed and could not act on there and then.
//!
//! The billboard is about *now* — "I am reworking the transcript panel, leave
//! `markdown.ts` alone" — and a notice is worthless the moment that stops being
//! true, which is why every mechanism in `board.rs` is about taking one down.
//! This is the other half of that, and it is the opposite in every respect that
//! matters. An item here is a **finding**: a bug seen in passing while doing
//! something else, a tool that should exist, a rough edge worth someone's
//! afternoon, a thing to take care of later. Its whole value is that it survives
//! the turn that found it, the card that found it, and the session both were in.
//!
//! Without somewhere to put those, an agent has exactly two options for a thing
//! it notices but must not stop for, and both lose it: say it in a transcript
//! nobody will scroll back through, or act on it now and blow the scope of the
//! job it was asked to do. The commonest outcome is the third one — say nothing.
//!
//! Four tools, and the fourth is the one that makes the other three worth
//! having:
//!
//! - `sink` reads it. Free, like the board, and for the same reason.
//! - `drop` puts something in. One title, one paragraph, optionally the files.
//! - `take` claims one, so two cards do not both do it. **Nothing here is
//!   assigned**: an agent reads the sink because it was asked to, or because it
//!   is about to do something the sink has an opinion about. A box that handed
//!   out work would be a scheduler, and the wall already has one of those — you.
//! - `done` takes it down, with a line saying what was actually done about it.
//!
//! ### Why a hold expires and a notice does not
//!
//! Both go stale; only one of them gives way. `board::STALE_AFTER_MS` *marks* a
//! notice and never removes it, because a long refactor is a real thing and
//! deleting a true notice is worse than showing an old one. A hold has to
//! actually expire, because while it stands the item is blocked — so the cost of
//! keeping a dead hold is not a stale paragraph, it is work nobody can pick up,
//! forever, on the word of a card that wandered off two days ago.
//!
//! So `HOLD_STALE_MS` is load-bearing and, for the same reason, generous:
//! expiring a hold somebody is still honouring costs two agents doing one job
//! and finding out in the diff. Two hours, against the board's ninety minutes,
//! and the asymmetry is deliberate rather than a rounding of the same number.
//! The reliable clearing is still the one that needs nobody to remember —
//! `release_for`, where a card closes or is cleared — and `sweep` on every read
//! is the crash backstop.
//!
//! ### What the sink is not
//!
//! It does not come and find you. `board::on_touch` serves a notice to a card
//! that writes to a file it covers, because a notice is about work *in flight*
//! and arriving late makes it useless. An item here has no deadline and no
//! claim on anybody's attention; interrupting a card mid-task with "by the way,
//! somebody once thought this file was untidy" would teach the wall's agents
//! that Skein's own messages can be skimmed. It is read when it is asked for.

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::store::{SinkItem, Store};

pub const SINK_TOOL: &str = "sink";
pub const DROP_TOOL: &str = "drop";
pub const TAKE_TOOL: &str = "take";
pub const DONE_TOOL: &str = "done";

/// How many still-open items one card may have dropped.
///
/// Twelve. Higher than the board's four, because these accumulate honestly over
/// a long session where notices do not, and low enough that a card which has
/// started narrating every thought into the sink is stopped while the box is
/// still readable. Refused rather than rotated, for `board::MAX_PER_CARD`'s
/// reason: an agent whose oldest item was silently dropped would go on
/// believing it had been written down.
const MAX_OPEN_PER_CARD: i64 = 12;

/// How many items one card may hold at once.
///
/// Three. A hold is a claim to be doing the thing now, and an agent doing three
/// things at once is an agent doing none of them — while every item it holds is
/// one no other card will touch.
const MAX_HELD: i64 = 3;

/// When a hold stops being believed. See the module note: deliberately longer
/// than the billboard's staleness, because this one gives way.
const HOLD_STALE_MS: i64 = 120 * 60 * 1_000;

/// How long a title may be.
///
/// A title is not prose, it is the item's **name**: it is drawn in a row in the
/// Basin, it is what `resolve` matches when an agent types a title back instead
/// of an id, and it is what `store::put_sink_item` merges on. So it has a real
/// width past which more characters are not more information — but a cut one is
/// not free the way a card's title is (`spawn::MAX_TITLE` argues that case), and
/// that is why this one has to be *announced*: a silently shortened title is an
/// identity key altered behind the caller's back.
const MAX_TITLE: usize = 120;

/// How long a settling note may be. A sentence or two on what happened to an
/// item, not a second body.
const MAX_NOTE: usize = 400;

/* A body has no cap here on purpose. It used to have one — 1,200 characters,
   applied before the text ever reached the store, which had its own cap of
   4,000 for the same field. Two numbers on one field, 3.3x apart, and the
   tighter one silently won: sixteen open items were measured sitting exactly on
   it, every one of them ending mid-sentence, one mid-word inside the sentence
   explaining its own cause (sink `7b26058e`).

   The argument for clipping here did not survive being looked at, and it is the
   same one that retired `spawn::MAX_PROMPT`: the body arrives as MCP
   `tools/call` arguments, so it was written inside the calling agent's own
   output budget and is already paid for by the time `do_drop` sees it. Clipping
   saved nothing and threw away only the half the author believed they had
   filed — and a sink item is the *archive*, the thing meant to outlive the card
   that wrote it, which makes it the worst place on the wall to lose a tail.

   `store::MAX_SINK_BODY` is the one cap, enforced where the write happens,
   through `crate::clip`. */
const MAX_GLOBS: usize = 8;

/// The four an agent may set. `note` is the default and the least committal —
/// nothing in Skein reads these except the widget's grouping and your own eye,
/// so the vocabulary is small on purpose: a taxonomy an agent has to think about
/// is one it will get wrong in a way that hides the item.
const KINDS: [&str; 4] = ["note", "idea", "bug", "chore"];

#[derive(Clone, Serialize)]
struct SinkChanged {
    project_id: Option<String>,
}

fn changed(app: &AppHandle, project_id: Option<String>) {
    let _ = app.emit("sink:changed", SinkChanged { project_id });
}

pub fn hold_stale(item: &SinkItem, now: i64) -> bool {
    match item.held_at {
        Some(at) => now - at > HOLD_STALE_MS,
        None => false,
    }
}

/// Is this item free to be taken? A hold nobody has honoured for two hours is
/// not a hold — see the module note.
fn free(item: &SinkItem, now: i64) -> bool {
    item.held_by.is_none() || hold_stale(item, now)
}

/// May you reword this one, and if not, why not.
///
/// Yours alone — no agent reaches it, which is a decision rather than an
/// omission. An item is a *report*, and a tool letting one card rewrite another
/// card's finding would make the sink a place where what you read may not be
/// what was found; the wall already has a way for one agent to add to another's
/// item, and it is `drop`, which merges and counts the voice. What the user
/// needs is narrower and different: a typo'd title, a half-thought body, a kind
/// filed wrong. So this is a verb on the face, and the two bounds below are the
/// whole of its policy.
///
/// **Pending, and unheld.** A held item is another card's work in flight, and
/// editing the brief under it is precisely the hazard the billboard exists to
/// prevent — arriving through the one door the billboard does not watch, since
/// nothing tells a working agent that the thing it is working from has changed.
/// A settled item is history. `Basin.svelte` does not *offer* the affordance in
/// either case; this is what makes the refusal true when a hold lands between
/// the offer and the save, and it says which of the two it was because the face
/// draws the sentence beside the words you typed.
///
/// A lapsed hold is not a hold, here as everywhere else — `free`'s call, so what
/// the widget offers and what the write allows cannot disagree.
fn may_edit(item: &SinkItem, now: i64) -> Result<(), String> {
    if item.settled_at.is_some() {
        return Err(
            "that item has been settled, and a settled item is history — put it back first \
             if it wants rewording"
                .into(),
        );
    }
    match &item.held_by {
        Some(h) if !free(item, now) => Err(format!(
            "{} is holding that item and is working from these words — free the hold first, \
             or wait for it to finish",
            crate::relay::handle_of(h)
        )),
        _ => Ok(()),
    }
}

/// Is another item already called this?
///
/// **Merging on the title is load-bearing** (see `store::put_sink_item`): a
/// re-drop under a title already in the sink adds a voice to that item rather
/// than making a second one, so two pending items sharing a title in one scope
/// is a state nothing else in this subsystem can produce — and one where the
/// next agent to meet the thing would second whichever of the two the query
/// happened to reach first.
///
/// So a rename onto an occupied title is refused rather than merged. Refused,
/// because merging here would fold the words you are in the middle of writing
/// into another item's body with nothing in this subsystem to undo it; and not
/// simply allowed, because that leaves the invariant broken and the merge
/// arbitrary. Being told which item holds the title costs you one gesture and
/// loses nothing.
///
/// Scoped like the merge itself: same project, or both wall-wide. Two items with
/// one title in two different projects are two findings about two repositories
/// and always were.
fn title_taken<'a>(items: &'a [SinkItem], item: &SinkItem, title: &str) -> Option<&'a SinkItem> {
    items.iter().find(|i| {
        i.id != item.id
            && i.settled_at.is_none()
            && i.project_id == item.project_id
            && i.title.eq_ignore_ascii_case(title)
    })
}

/* ── the tools ────────────────────────────────────────────────────────────── */

pub fn sink_schema() -> Value {
    json!({
        "name": SINK_TOOL,
        "description":
            "Read the sink: the wall's standing pile of things somebody noticed and did \
             not stop for — bugs seen in passing, tools that should exist, rough edges, \
             things to take care of later. Unlike the billboard, nothing here is about \
             work in flight and nothing here expires; an item sits until it is settled.\n\n\
             Read it when you are asked what is pending, when you are about to work \
             somewhere and want to know what is already known about it, or when you have \
             finished what you were asked and are looking for the next useful thing. \
             Reading costs nobody a turn.\n\n\
             **Nothing here is assigned to you.** An item marked as held is one another \
             conversation has said it is doing — leave it alone. Anything else is fair to \
             `take`, but take it because the user asked or because you are already there, \
             not merely because it is unheld.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "scope": {
                    "type": "string",
                    "enum": ["project", "skein"],
                    "description":
                        "`project` (the default) is this project's items plus the \
                         wall-wide ones. `skein` is everything in the studio."
                },
                "settled": {
                    "type": "boolean",
                    "description":
                        "Show what has already been addressed instead of what is \
                         pending. For answering 'has anyone dealt with this' before \
                         raising it again."
                },
                "kind": {
                    "type": "string",
                    "enum": ["note", "idea", "bug", "chore"],
                    "description": "Only items of this kind."
                }
            }
        }
    })
}

pub fn drop_schema() -> Value {
    json!({
        "name": DROP_TOOL,
        "description":
            "Put something in the sink, so it outlives this conversation. For the thing \
             you noticed and must not stop for: a bug you walked past while doing \
             something else, a Skein tool that should exist or misbehaved on you, a file \
             that needs an afternoon, a decision somebody should make. It persists across \
             sessions and survives this card being closed.\n\n\
             **This is not a to-do list for the turn you are in.** Do not drop what you \
             are about to do anyway, and do not drop what the repository already records \
             — a bug with a failing test, something already in the git log, anything a \
             comment in the code says. Write the thing that would otherwise be lost.\n\n\
             Dropping under a title that is already in the sink adds your voice to that \
             item rather than making a second one, and the receipt says so.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": {
                    "type": "string",
                    "description":
                        "The thing itself, in one line, specific enough to act on \
                         months later — 'ask_user times out in a non-interactive \
                         session', not 'asking is broken'. This is what a repeat of the \
                         same finding is matched on."
                },
                "body": {
                    "type": "string",
                    "description":
                        "What somebody picking this up needs: what you saw, where, what \
                         you think is behind it, and how you would know it was fixed. \
                         Write it for another agent with its own context — name files by \
                         path. If you were mid-task when you found it, say what you were \
                         doing, because that is usually the reproduction."
                },
                "kind": {
                    "type": "string",
                    "enum": ["note", "idea", "bug", "chore"],
                    "description":
                        "`bug` for something wrong, `idea` for something that should \
                         exist, `chore` for work that is nobody's idea of interesting \
                         but wants doing, `note` (the default) for anything else worth \
                         keeping."
                },
                "paths": {
                    "description":
                        "Optional. Files this is about — 'src/lib/markdown.ts', \
                         'store.rs'. Give them whenever you know them: it is what lets \
                         somebody working in that file find this without reading the \
                         whole sink.",
                    "anyOf": [
                        { "type": "string" },
                        { "type": "array", "items": { "type": "string" } }
                    ]
                },
                "scope": {
                    "type": "string",
                    "enum": ["project", "skein"],
                    "description":
                        "`project` (the default) files it under this project. `skein` is \
                         for something about the studio itself rather than any one \
                         repository."
                }
            },
            "required": ["title", "body"]
        }
    })
}

pub fn take_schema() -> Value {
    json!({
        "name": TAKE_TOOL,
        "description":
            "Say you are dealing with an item in the sink, so no other conversation on \
             this wall starts the same work. Do this **before** you begin, not after — a \
             claim made at the end is a claim that prevented nothing.\n\n\
             One card holds an item at a time, so this can be refused; if it is, you are \
             told who holds it and you should leave it to them and say so. Calling it \
             again on something you already hold keeps the hold fresh, which is worth \
             doing on a long piece of work.\n\n\
             **Put it back with `release` if you stop without finishing**, including when \
             the user redirects you onto something else. A held item nobody is working on \
             is worse than an unheld one: it is invisible to everybody and blocked for \
             everybody.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "item": {
                    "type": "string",
                    "description": "The item's id as `sink` reported it, or its exact title."
                },
                "release": {
                    "type": "boolean",
                    "description":
                        "Put it back instead of taking it — you have stopped, and it is \
                         not done."
                }
            },
            "required": ["item"]
        }
    })
}

pub fn done_schema() -> Value {
    json!({
        "name": DONE_TOOL,
        "description":
            "Take an item out of the sink because it has actually been dealt with. This \
             is the half that makes the rest of it worth reading: a sink of things that \
             were quietly fixed months ago is one nobody trusts, and then nobody looks, \
             and then nothing in it gets done.\n\n\
             Only when it is **fully** addressed — the change is made and stands up. If \
             you did part of it, leave the item and `drop` what is left as its own thing, \
             or say so in the note and leave it standing. It is kept, not deleted, so the \
             user can put it back if you were wrong about it.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "item": {
                    "type": "string",
                    "description": "The item's id as `sink` reported it, or its exact title."
                },
                "note": {
                    "type": "string",
                    "description":
                        "What was actually done about it, in a line — the commit, the \
                         fix, or why it turned out not to be a problem. This is all \
                         anybody reading the settled list later will have."
                }
            },
            "required": ["item"]
        }
    })
}

/* ── who is reading ───────────────────────────────────────────────────────── */

struct Reader {
    /// Which project's sink is this card's own. `None` for a card the store has
    /// no row for, which reads the whole wall rather than nothing.
    project_id: Option<String>,
    /// A chat card stands in a territory that is not a repository, so its items
    /// go to the wall rather than to that territory — see the note in `do_drop`.
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
        None => Reader { project_id: None, chat: false },
    }
}

/// Everything this card may see, swept first.
fn visible(app: &AppHandle, me: &Reader, all: bool, settled: bool) -> Result<Vec<SinkItem>, String> {
    let store = app.state::<Store>();
    let conn = store.0.lock().map_err(|_| "the store is unavailable".to_string())?;
    crate::store::sweep_sink_holds(&conn);
    let scope = if all { None } else { me.project_id.as_deref() };
    crate::store::sink_items(&conn, scope, settled)
}

/* ── reading ──────────────────────────────────────────────────────────────── */

fn do_sink(app: &AppHandle, caller: &str, args: &Value) -> String {
    let me = reader(app, caller);
    let all = args.get("scope").and_then(Value::as_str) == Some("skein");
    let settled = args.get("settled").and_then(Value::as_bool) == Some(true);
    let want_kind = args.get("kind").and_then(Value::as_str).map(str::to_lowercase);

    let items = match visible(app, &me, all, settled) {
        Ok(i) => i,
        Err(e) => return format!("could not read the sink: {e}"),
    };
    let items: Vec<&SinkItem> = items
        .iter()
        .filter(|i| want_kind.as_deref().is_none_or(|k| i.kind == k))
        .collect();

    if items.is_empty() {
        return if settled {
            "nothing in the sink has been settled yet.".into()
        } else {
            "the sink is empty — nobody has left anything in it.".into()
        };
    }

    let now = crate::store::now();
    let mut out = String::new();
    if settled {
        out.push_str("Already dealt with — do not raise these again unless they are back:\n\n");
        for i in &items {
            out.push_str(&render(i, now, caller));
        }
        return out;
    }

    /* Yours first, and said out loud, for `do_board`'s reason: an agent that
       sees what it is holding at the top of every read is one that remembers it
       is holding it. */
    let (mine, rest): (Vec<&&SinkItem>, Vec<&&SinkItem>) =
        items.iter().partition(|i| i.held_by.as_deref() == Some(caller));

    if !mine.is_empty() {
        out.push_str(
            "You are holding these — finish them with `done`, or put them back with \
             `take … release: true` if you have stopped:\n\n",
        );
        for i in &mine {
            out.push_str(&render(i, now, caller));
        }
        out.push('\n');
    }

    let (held, open): (Vec<&&&SinkItem>, Vec<&&&SinkItem>) =
        rest.iter().partition(|i| !free(i, now));

    if !open.is_empty() {
        out.push_str("Waiting, nobody on them:\n\n");
        for i in &open {
            out.push_str(&render(i, now, caller));
        }
    } else if mine.is_empty() {
        out.push_str("Nothing is waiting — every item is held.\n");
    }
    if !held.is_empty() {
        out.push_str("\nHeld by another conversation — leave these alone:\n\n");
        for i in &held {
            out.push_str(&render(i, now, caller));
        }
    }
    out
}

fn render(i: &SinkItem, now: i64, caller: &str) -> String {
    let voices = if i.voices > 1 {
        format!(" ×{}", i.voices)
    } else {
        String::new()
    };
    let who = match &i.from_id {
        Some(id) if id == caller => "you".to_string(),
        Some(id) => crate::relay::handle_of(id),
        None => "the user".into(),
    };
    let globs = globs_of(i);
    let files = if globs.is_empty() {
        String::new()
    } else {
        format!("\n  files: {}", globs.join(", "))
    };
    let hold = match (&i.held_by, i.held_at) {
        (Some(h), _) if h == caller => " · yours".to_string(),
        (Some(h), Some(at)) if now - at > HOLD_STALE_MS => format!(
            " · was held by {}, {} and untouched since — free to take",
            crate::relay::handle_of(h),
            ago(now - at)
        ),
        (Some(h), Some(at)) => format!(" · held by {}, {}", crate::relay::handle_of(h), ago(now - at)),
        (Some(h), None) => format!(" · held by {}", crate::relay::handle_of(h)),
        (None, _) => String::new(),
    };
    let settled = match (i.settled_at, &i.settled_note) {
        (Some(at), Some(note)) => format!("\n  settled {}: {note}", ago(now - at)),
        (Some(at), None) => format!("\n  settled {}", ago(now - at)),
        _ => String::new(),
    };
    /* Said out loud, because the line above it says who dropped this and the
       words below it may no longer be theirs. An item reading "dropped by lucid
       otter" while carrying a body the user rewrote yesterday attributes their
       reasoning to a card that never said it — and that matters more here than
       it would anywhere else, since most of what a long-lived sink holds was
       dropped by conversations no longer on the wall to be asked. It also tells
       an agent the thing worth knowing: these are the words the user wants acted
       on, whatever was reported. */
    let edited = match i.edited_at {
        Some(at) if i.from_id.is_some() => {
            format!(" · the user reworded this {}", ago(now - at))
        }
        _ => String::new(),
    };
    format!(
        "- [{}] {}{voices} — {}\n  {}{files}\n  dropped by {who}, {}{hold}{edited}{settled}\n",
        i.id.chars().take(8).collect::<String>(),
        i.kind,
        i.title,
        i.body.replace('\n', "\n  "),
        ago(now - i.dropped_at),
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

/* ── dropping ─────────────────────────────────────────────────────────────── */

fn do_drop(app: &AppHandle, caller: &str, args: &Value) -> String {
    let me = reader(app, caller);
    let Some(title) = args.get("title").and_then(Value::as_str) else {
        return "no `title` was given, so nothing was dropped".into();
    };
    let title_cut = crate::clip::keep(title.trim(), MAX_TITLE);
    let title = title_cut.kept.clone();
    if title.is_empty() {
        return "the title was empty, so nothing was dropped".into();
    }
    /* Not clipped here — see the note beside `MAX_TITLE`. `store::MAX_SINK_BODY`
       is the only cap on a body, and it reports what it took. */
    let body = args
        .get("body")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if body.is_empty() {
        return "no `body` was given — a title on its own is a thing nobody will be able \
                to act on in a month, so nothing was dropped"
            .into();
    }
    let kind = args
        .get("kind")
        .and_then(Value::as_str)
        .map(str::to_lowercase)
        .filter(|k| KINDS.contains(&k.as_str()))
        .unwrap_or_else(|| "note".into());
    let paths = globs_from(args.get("paths"));

    /* A chat card's territory is Skein's own data folder rather than a
       repository (see `.claude/rules/chat.md`), so filing an item under it would
       put the finding somewhere nobody will ever look for it. Its items go to
       the wall instead. The one card that cannot read a file is also the one
       most likely to meet an `ask_user` fault worth reporting, so refusing it
       outright — which is what `board` and `relay` do — would lose exactly the
       reports this exists to collect. */
    let wall = args.get("scope").and_then(Value::as_str) == Some("skein") || me.chat;
    let project_id = if wall { None } else { me.project_id.clone() };
    if !wall && project_id.is_none() {
        return "this card is not on the wall, so it has no project to file this under — \
                pass `scope: \"skein\"` to leave it for the studio"
            .into();
    }

    let store = app.state::<Store>();
    let Ok(conn) = store.0.lock() else {
        return "the store is unavailable".into();
    };
    if crate::store::sink_dropped_count(&conn, caller) >= MAX_OPEN_PER_CARD {
        return format!(
            "this card has already left {MAX_OPEN_PER_CARD} unsettled items in the \
             sink, which is the limit. Read the sink and settle or narrow what is \
             already there before adding more — a pile this long is one nobody reads."
        );
    }
    let id = crate::store::uuid_v4();
    let put = crate::store::put_sink_item(
        &conn,
        &id,
        project_id.as_deref(),
        &kind,
        &title,
        &body,
        &paths,
        Some(caller),
    );
    drop(conn);

    match put {
        Err(e) => format!("could not drop that: {e}"),
        Ok(p) => {
            changed(app, project_id);
            /* The writer's half of the marker. The stored text tells whoever
               reads the item; this tells the agent that still has the whole
               thing in hand, which is the only moment anything can be done
               about it. `board.rs` has said it this way since it was written —
               this is that pattern, finally applied here too. */
            let cuts = clipped_note(&title_cut, p.body_omitted);
            if p.merged {
                let voices = if p.voices > 1 {
                    format!(" {} conversations have now met it.", p.voices)
                } else {
                    String::new()
                };
                format!(
                    "{title:?} was already in the sink, so this went onto that item \
                     rather than making a second one — anything your words added is on \
                     it now.{voices} It is [{}]. Tell the user you seconded an existing \
                     item rather than raising a new one.{cuts}",
                    p.id.chars().take(8).collect::<String>()
                )
            } else {
                format!(
                    "dropped into the {} sink as [{}]: {title:?}. It will outlive this \
                     conversation. Nobody is assigned to it — if you are about to deal \
                     with it yourself, `take` it first.{cuts}",
                    if wall { "wall-wide" } else { "project" },
                    p.id.chars().take(8).collect::<String>()
                )
            }
        }
    }
}

/* ── taking and settling ──────────────────────────────────────────────────── */

/// Find the item an agent means. Full id, then its short head, then the exact
/// title — the same ladder `relay::resolve` and `do_unpost` walk, because the
/// agent was shown both spellings and either is a fair thing to type back.
fn resolve<'a>(items: &'a [SinkItem], want: &str) -> Option<&'a SinkItem> {
    let want = want.trim();
    items
        .iter()
        .find(|i| i.id == want)
        .or_else(|| items.iter().find(|i| i.id.starts_with(want) && want.len() >= 4))
        .or_else(|| items.iter().find(|i| i.title.eq_ignore_ascii_case(want)))
}

fn do_take(app: &AppHandle, caller: &str, args: &Value) -> String {
    let me = reader(app, caller);
    let Some(want) = args.get("item").and_then(Value::as_str) else {
        return "name the item by its id or its exact title".into();
    };
    let release = args.get("release").and_then(Value::as_bool) == Some(true);

    /* Read across the whole wall rather than this card's scope: an id an agent
       was given is one it should be able to act on, and an item it can see in a
       `skein`-scoped read but not take would be a distinction nothing in the
       tool's description prepares it for. */
    let items = match visible(app, &me, true, false) {
        Ok(i) => i,
        Err(e) => return format!("could not read the sink: {e}"),
    };
    let Some(item) = resolve(&items, want) else {
        return not_found(&items, want);
    };
    let now = crate::store::now();

    if release {
        if item.held_by.as_deref() != Some(caller) {
            return match &item.held_by {
                Some(h) => format!(
                    "{:?} is held by {}, not by you — nothing to put back.",
                    item.title,
                    crate::relay::handle_of(h)
                ),
                None => format!("{:?} was not held by anyone.", item.title),
            };
        }
        let store = app.state::<Store>();
        let Ok(conn) = store.0.lock() else {
            return "the store is unavailable".into();
        };
        let ok = crate::store::hold_sink_item(&conn, &item.id, None, Some(caller));
        drop(conn);
        if ok {
            changed(app, item.project_id.clone());
            return format!(
                "put {:?} back. It is waiting for whoever picks it up next — if you got \
                 part of the way, `drop` what you learned so that is not lost too.",
                item.title
            );
        }
        return format!("{:?} had already moved on.", item.title);
    }

    if item.held_by.as_deref() == Some(caller) {
        let store = app.state::<Store>();
        let Ok(conn) = store.0.lock() else {
            return "the store is unavailable".into();
        };
        crate::store::touch_sink_hold(&conn, &item.id, caller);
        drop(conn);
        changed(app, item.project_id.clone());
        return format!("you already hold {:?} — the hold is fresh again.", item.title);
    }

    if !free(item, now) {
        let who = item
            .held_by
            .as_deref()
            .map(crate::relay::handle_of)
            .unwrap_or_default();
        return format!(
            "{:?} is held by {who}, who said so {}. Leave it to them and tell the user \
             that is why you did not start it — if it genuinely needs two of you, \
             message {who} rather than working over them.",
            item.title,
            item.held_at.map(|at| ago(now - at)).unwrap_or_else(|| "recently".into())
        );
    }

    let store = app.state::<Store>();
    let Ok(conn) = store.0.lock() else {
        return "the store is unavailable".into();
    };
    let held = crate::store::sink_held_count(&conn, caller);
    if held >= MAX_HELD {
        return format!(
            "this card is already holding {held} items, which is the limit — every one \
             of them is an item no other conversation will touch. Finish one with `done` \
             or put it back before taking this."
        );
    }
    /* Conditional on the hold we read, so two cards claiming this in the same
       instant cannot both be told they have it — see `store::hold_sink_item`. */
    let ok = crate::store::hold_sink_item(&conn, &item.id, Some(caller), item.held_by.as_deref());
    drop(conn);
    if !ok {
        return format!(
            "{:?} was taken by another conversation a moment before you — leave it to \
             them.",
            item.title
        );
    }
    changed(app, item.project_id.clone());
    let was = match &item.held_by {
        Some(h) => format!(
            " It had been held by {} since {}, untouched long enough to be free.",
            crate::relay::handle_of(h),
            item.held_at.map(|at| ago(now - at)).unwrap_or_else(|| "some time".into())
        ),
        None => String::new(),
    };
    format!(
        "you are holding {:?}.{was} No other conversation will start it while you have \
         it. `done` when it is fully addressed, or `take … release: true` the moment you \
         stop.",
        item.title
    )
}

fn do_done(app: &AppHandle, caller: &str, args: &Value) -> String {
    let me = reader(app, caller);
    let Some(want) = args.get("item").and_then(Value::as_str) else {
        return "name the item by its id or its exact title".into();
    };
    let note = args
        .get("note")
        .and_then(Value::as_str)
        .map(|n| {
            crate::clip::keep(n.trim(), MAX_NOTE).marked(
                "A note is a sentence or two on what happened, not a second body — if \
                 there is more to say, it belongs in the item's own words.",
            )
        })
        .filter(|n| !n.is_empty());

    let items = match visible(app, &me, true, false) {
        Ok(i) => i,
        Err(e) => return format!("could not read the sink: {e}"),
    };
    let Some(item) = resolve(&items, want) else {
        return not_found(&items, want);
    };
    let now = crate::store::now();

    /* Somebody else's live hold is a refusal rather than a warning. `done` on an
       item another card is in the middle of is either two agents on one job — in
       which case the news the user needs is the collision, not the tick — or an
       agent settling work it did not do. Both are worse than being told no. A
       hold that has gone stale is not a hold, so that case falls through. */
    if let Some(h) = &item.held_by {
        if h != caller && !hold_stale(item, now) {
            return format!(
                "{:?} is held by {} — they are dealing with it, so this is not yours to \
                 take down. If you have just done the same work, say so to the user and \
                 message {} rather than settling it over them.",
                item.title,
                crate::relay::handle_of(h),
                crate::relay::handle_of(h)
            );
        }
    }

    let store = app.state::<Store>();
    let Ok(conn) = store.0.lock() else {
        return "the store is unavailable".into();
    };
    let ok = crate::store::settle_sink_item(&conn, &item.id, note.as_deref());
    drop(conn);
    if !ok {
        return format!("{:?} was already settled.", item.title);
    }
    changed(app, item.project_id.clone());
    let asked = if note.is_none() {
        " It is kept with no note on it, which is a thin record — say what you did about \
         it next time."
    } else {
        ""
    };
    format!(
        "took {:?} out of the sink.{asked} It is kept rather than deleted, so the user \
         can put it back if it turns out not to be finished.",
        item.title
    )
}

fn not_found(items: &[SinkItem], want: &str) -> String {
    if items.is_empty() {
        return "there is nothing in the sink.".into();
    }
    format!(
        "no item called {want:?}. Read `sink` for the ids — the ones there now are: {}",
        items
            .iter()
            .take(8)
            .map(|i| format!("[{}] {:?}", i.id.chars().take(8).collect::<String>(), i.title))
            .collect::<Vec<_>>()
            .join(", ")
    )
}

/* ── shared with the board ────────────────────────────────────────────────── */

fn globs_of(item: &SinkItem) -> Vec<&str> {
    item.paths
        .lines()
        .map(str::trim)
        .filter(|g| !g.is_empty())
        .collect()
}

/// Whatever the model wrote, as newline-separated globs. Same shape as
/// `board::globs_from`, and deliberately not shared with it: the two will drift
/// (a notice's globs are matched against live writes, an item's are read by a
/// human) and a common helper would make the next change to either one a
/// question about both.
fn globs_from(v: Option<&Value>) -> String {
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
    list.into_iter().take(MAX_GLOBS).collect::<Vec<_>>().join("\n")
}

/// What to add to a receipt when the write could not carry everything.
///
/// Empty in the ordinary case, so it can be interpolated unconditionally. It
/// names the title and the body separately because they are lost for different
/// reasons and only one of them can be made good: a title is furniture and can
/// be re-worded, a body's tail is simply gone.
fn clipped_note(title: &crate::clip::Cut, body_omitted: usize) -> String {
    let mut out = String::new();
    if title.happened() {
        out.push_str(&format!(
            " **The title was {} characters over the {MAX_TITLE} a title may be, and has \
             been shortened** — it is the name this item is found and merged by, so check \
             it reads as you meant and reword it if not.",
            title.omitted,
        ));
    }
    if body_omitted > 0 {
        out.push_str(&format!(
            " **{body_omitted} characters of the body did not fit** the {} a sink item \
             may hold and are not stored. What went up says so where it was cut. An item \
             this long has become a conversation — file the remainder as its own item and \
             name this one in it.",
            crate::store::MAX_SINK_BODY,
        ));
    }
    out
}

/* ── the wall's way in ────────────────────────────────────────────────────── */

fn as_json(i: &SinkItem, now: i64) -> Value {
    json!({
        "id": i.id,
        "projectId": i.project_id,
        "kind": i.kind,
        "title": i.title,
        "body": i.body,
        "paths": globs_of(i),
        "from": i.from_id,
        "droppedAt": i.dropped_at,
        "touchedAt": i.touched_at,
        "voices": i.voices,
        "heldBy": i.held_by,
        "heldAt": i.held_at,
        /* Computed here rather than in the webview, for `board::as_json`'s
           reason: the reading an agent is given and the reading you are given
           must not be able to disagree about whether a hold still stands. */
        "holdStale": hold_stale(i, now),
        "settledAt": i.settled_at,
        "settledNote": i.settled_note,
        "editedAt": i.edited_at,
    })
}

#[tauri::command]
pub fn read_sink(
    app: AppHandle,
    project_id: Option<String>,
    settled: Option<bool>,
) -> Result<Value, String> {
    let store = app.state::<Store>();
    let conn = store.0.lock().map_err(|_| "the store is unavailable")?;
    crate::store::sweep_sink_holds(&conn);
    let items = crate::store::sink_items(&conn, project_id.as_deref(), settled.unwrap_or(false))?;
    let now = crate::store::now();
    Ok(json!(items.iter().map(|i| as_json(i, now)).collect::<Vec<_>>()))
}

/// Drop something in as *yourself*. An item with no card behind it, which is the
/// one thing in the sink that is not a report from an agent — it is an
/// instruction, and the reading says "from the user".
#[tauri::command]
pub fn sink_add(
    app: AppHandle,
    title: String,
    body: String,
    kind: Option<String>,
    paths: Option<Vec<String>>,
    project_id: Option<String>,
) -> Result<String, String> {
    let title = crate::clip::keep(title.trim(), MAX_TITLE).kept;
    if title.is_empty() {
        return Err("an item needs a title".into());
    }
    let kind = kind
        .map(|k| k.to_lowercase())
        .filter(|k| KINDS.contains(&k.as_str()))
        .unwrap_or_else(|| "note".into());
    let id = crate::store::uuid_v4();
    let globs = globs_from(paths.map(|p| json!(p)).as_ref());
    let put = {
        let store = app.state::<Store>();
        let conn = store.0.lock().map_err(|_| "the store is unavailable")?;
        crate::store::put_sink_item(
            &conn,
            &id,
            project_id.as_deref(),
            &kind,
            &title,
            body.trim(),
            &globs,
            None,
        )?
    };
    changed(&app, project_id);
    Ok(put.id)
}

/// Reword one, which is yours alone. See `may_edit` for why no agent reaches it.
///
/// Everything an agent may set when it drops something, you may set again: the
/// title, the body, the kind it was filed under, the files it names. What does
/// not move is the provenance — an edit does not make the item yours, because
/// the finding was still theirs — nor `dropped_at`, nor `voices`, nor the scope.
/// `store::edit_sink_item` is where those absences are argued.
///
/// **Off the main thread**, for `sink_tool`'s reason: this holds the store's lock
/// across a read of the whole pending pile (the title check), a write, and an
/// emit, and a command that blocks on the main thread stops every card on the
/// wall from being painted for as long as it blocks. See `crate::off_main`.
#[tauri::command]
pub async fn sink_edit(
    app: AppHandle,
    id: String,
    title: String,
    body: String,
    kind: Option<String>,
    paths: Option<Vec<String>>,
) -> Result<(), String> {
    let title = crate::clip::keep(title.trim(), MAX_TITLE).kept;
    if title.is_empty() {
        return Err("an item needs a title".into());
    }
    /* `edit_sink_item` writes what it is handed, so unlike `put_sink_item` this
       path has to do its own clipping — and it is the one path where the author
       is a person at a keyboard rather than an agent, so the field in the Basin
       stops where this does (`sink.ts`'s `MAX_BODY`) and the marker is a
       backstop rather than the first they hear of it. */
    let body = crate::clip::keep(body.trim(), crate::store::MAX_SINK_BODY)
        .marked(crate::store::BODY_REMEDY);
    /* The same bar `do_drop` sets, and for the same span of time: a title on its
       own is a thing nobody will be able to act on in a month. An edit that
       emptied the body would take an item below the bar it had to clear to get
       in. */
    if body.is_empty() {
        return Err(
            "an item needs a body — a title on its own is a thing nobody will be able to \
             act on in a month"
                .into(),
        );
    }
    let kind = kind
        .map(|k| k.to_lowercase())
        .filter(|k| KINDS.contains(&k.as_str()))
        .unwrap_or_else(|| "note".into());
    let globs = globs_from(paths.map(|p| json!(p)).as_ref());

    crate::off_main(move || {
        let store = app.state::<Store>();
        let conn = store.0.lock().map_err(|_| "the store is unavailable")?;
        let Some(item) = crate::store::sink_one(&conn, &id) else {
            return Err("that item is not in the sink any more".into());
        };
        let now = crate::store::now();
        may_edit(&item, now)?;

        let pending = crate::store::sink_items(&conn, None, false)?;
        if let Some(other) = title_taken(&pending, &item, &title) {
            return Err(format!(
                "another item is already called that — [{}] — and two items with one title \
                 is what merging on the title exists to prevent. settle one of them, or \
                 pick different words.",
                crate::relay::handle_of(&other.id)
            ));
        }

        let cutoff = now - HOLD_STALE_MS;
        if !crate::store::edit_sink_item(&conn, &id, &kind, &title, &body, &globs, cutoff) {
            /* `may_edit` said yes a moment ago, so the row moved underneath us —
               a card took it while you were typing. The UPDATE is the guard; see
               `store::edit_sink_item`. */
            return Err("somebody took that item while you were typing — nothing was changed".into());
        }
        let project_id = item.project_id.clone();
        drop(conn);
        changed(&app, project_id);
        Ok(())
    })
    .await?
}

/// Mark it dealt with, from the wall. No note: the note is what an *agent* has
/// to say about work it did, and you were there.
#[tauri::command]
pub fn sink_settle(app: AppHandle, id: String) -> Result<bool, String> {
    let ok = {
        let store = app.state::<Store>();
        let conn = store.0.lock().map_err(|_| "the store is unavailable")?;
        crate::store::settle_sink_item(&conn, &id, None)
    };
    changed(&app, None);
    Ok(ok)
}

/// Put a settled item back — the whole reason `done` keeps the row.
#[tauri::command]
pub fn sink_unsettle(app: AppHandle, id: String) -> Result<bool, String> {
    let ok = {
        let store = app.state::<Store>();
        let conn = store.0.lock().map_err(|_| "the store is unavailable")?;
        crate::store::unsettle_sink_item(&conn, &id)
    };
    changed(&app, None);
    Ok(ok)
}

/// Throw it away. Yours only — no agent reaches this.
#[tauri::command]
pub fn sink_delete(app: AppHandle, id: String) -> Result<bool, String> {
    let ok = {
        let store = app.state::<Store>();
        let conn = store.0.lock().map_err(|_| "the store is unavailable")?;
        crate::store::drop_sink_item(&conn, &id)
    };
    changed(&app, None);
    Ok(ok)
}

/// Prise a hold off an item, because you can see the card holding it is not
/// doing it. The hold expires on its own eventually; this is for when you know
/// sooner.
#[tauri::command]
pub fn sink_release(app: AppHandle, id: String) -> Result<bool, String> {
    let ok = {
        let store = app.state::<Store>();
        let conn = store.0.lock().map_err(|_| "the store is unavailable")?;
        crate::store::hold_sink_item(&conn, &id, None, None) || {
            let item = crate::store::sink_one(&conn, &id);
            match item.and_then(|i| i.held_by) {
                Some(h) => crate::store::hold_sink_item(&conn, &id, None, Some(&h)),
                None => false,
            }
        }
    };
    changed(&app, None);
    Ok(ok)
}

/// Drive one of the four tools by hand, as a named card.
///
/// One command rather than four, which is where this parts company with
/// `board::relay_post` and friends: those grew one at a time and each has its
/// own typed parameters, and the cost is four near-identical wrappers that must
/// be kept in step with four schemas. What `wall.test.ts` and the control
/// surface actually want is to make the call an agent would make, and the honest
/// spelling of that is the tool's name and the tool's arguments. Off the main
/// thread for `relay_send`'s reason: `do_drop` and `do_take` end in an emit and
/// hold the store's lock across a sweep.
#[tauri::command]
pub async fn sink_tool(
    app: AppHandle,
    id: String,
    tool: String,
    args: Option<Value>,
) -> Result<String, String> {
    let args = args.unwrap_or_else(|| json!({}));
    crate::off_main(move || {
        handle(&app, &id, &tool, &args)
            .unwrap_or_else(|| format!("the sink has no tool {tool:?}"))
    })
    .await
}

/// A card is going, or has been cleared. It lets go of what it was holding —
/// and that is all. The items stay: see `store::migrate_v18`.
pub fn release_for(app: &AppHandle, conversation_id: &str) {
    let Some(store) = app.try_state::<Store>() else { return };
    let n = {
        let Ok(conn) = store.0.lock() else { return };
        crate::store::release_sink_holds_of(&conn, conversation_id)
    };
    if n > 0 {
        changed(app, None);
    }
}

/// Route a `tools/call` that belongs to the sink. `None` for a name this file
/// does not claim, so `ask.rs` can go on asking.
pub fn handle(app: &AppHandle, conversation_id: &str, tool: &str, args: &Value) -> Option<String> {
    match tool {
        SINK_TOOL => Some(do_sink(app, conversation_id, args)),
        DROP_TOOL => Some(do_drop(app, conversation_id, args)),
        TAKE_TOOL => Some(do_take(app, conversation_id, args)),
        DONE_TOOL => Some(do_done(app, conversation_id, args)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::SinkItem;

    fn item(held_by: Option<&str>, held_at: Option<i64>) -> SinkItem {
        SinkItem {
            id: "abcd1234-0000".into(),
            project_id: None,
            kind: "bug".into(),
            title: "ask_user times out in a non-interactive session".into(),
            body: "the call parks for ten minutes".into(),
            paths: String::new(),
            from_id: None,
            dropped_at: 0,
            touched_at: 0,
            voices: 1,
            held_by: held_by.map(str::to_string),
            held_at,
            settled_at: None,
            settled_note: None,
            edited_at: None,
        }
    }

    #[test]
    fn an_unheld_item_is_free() {
        assert!(free(&item(None, None), 0));
    }

    #[test]
    fn a_fresh_hold_blocks_it() {
        let i = item(Some("c1"), Some(1_000));
        assert!(!free(&i, 1_000 + HOLD_STALE_MS / 2));
    }

    /// The half that parts company with the billboard: a hold nobody has
    /// honoured gives way, where a stale notice is only marked. See the module
    /// note.
    #[test]
    fn a_hold_nobody_has_honoured_gives_way() {
        let i = item(Some("c1"), Some(1_000));
        assert!(hold_stale(&i, 1_000 + HOLD_STALE_MS + 1));
        assert!(free(&i, 1_000 + HOLD_STALE_MS + 1));
    }

    /// A hold is longer-lived than a notice, deliberately — expiring one that is
    /// still being honoured costs two agents doing one job.
    #[test]
    fn a_hold_outlasts_a_notice() {
        assert!(HOLD_STALE_MS > 90 * 60 * 1_000);
    }

    #[test]
    fn an_item_resolves_by_id_by_its_head_and_by_title() {
        let items = vec![item(None, None)];
        assert!(resolve(&items, "abcd1234-0000").is_some());
        assert!(resolve(&items, "abcd").is_some());
        assert!(resolve(&items, "ASK_USER TIMES OUT IN A NON-INTERACTIVE SESSION").is_some());
        assert!(resolve(&items, "nothing like it").is_none());
    }

    /// Three characters is not enough of an id to act on. An agent that typed a
    /// fragment should be told what is there rather than handed whichever item
    /// happened to start with it.
    #[test]
    fn too_short_a_fragment_matches_nothing() {
        let items = vec![item(None, None)];
        assert!(resolve(&items, "abc").is_none());
    }

    #[test]
    fn a_missing_item_names_what_is_actually_there() {
        let items = vec![item(None, None)];
        let msg = not_found(&items, "the wrong thing");
        assert!(msg.contains("ask_user times out"), "{msg}");
    }

    #[test]
    fn globs_arrive_in_both_spellings() {
        assert_eq!(globs_from(Some(&json!("a.ts, b.ts"))), "a.ts\nb.ts");
        assert_eq!(globs_from(Some(&json!(["a.ts", "b.ts"]))), "a.ts\nb.ts");
        assert_eq!(globs_from(None), "");
    }

    #[test]
    fn the_four_tools_are_advertised_with_usable_schemas() {
        for s in [sink_schema(), drop_schema(), take_schema(), done_schema()] {
            assert!(s["name"].is_string());
            assert!(s["description"].as_str().unwrap().len() > 200);
            assert_eq!(s["inputSchema"]["type"], "object");
        }
    }

    /// `drop` is the one an agent will reach for without being asked, so its
    /// description has to say what *not* to put in — a box that fills with
    /// restatements of the git log is one nobody reads.
    #[test]
    fn drop_says_what_does_not_belong_in_the_sink() {
        let d = drop_schema()["description"].as_str().unwrap().to_string();
        assert!(d.contains("not a to-do list"));
        assert!(d.contains("already records"));
    }

    /// The hold is only worth having if an agent is told to put it back.
    #[test]
    fn take_says_to_put_it_back() {
        let d = take_schema()["description"].as_str().unwrap().to_string();
        assert!(d.contains("release"));
    }

    /* ── rewording one ────────────────────────────────────────────────────── */

    #[test]
    fn an_item_nobody_is_on_may_be_reworded() {
        assert!(may_edit(&item(None, None), 0).is_ok());
    }

    /// The bound that matters. A held item is another card's work in flight, and
    /// nothing tells a working agent that the words it is working from have
    /// changed — which is the billboard's hazard arriving through the one door
    /// the billboard does not watch.
    #[test]
    fn a_held_item_may_not_be_reworded() {
        let i = item(Some("c1abcdef-2222"), Some(1_000));
        let e = may_edit(&i, 1_000 + HOLD_STALE_MS / 2).unwrap_err();
        assert!(e.contains("c1abcdef"), "{e}");
        assert!(e.contains("free the hold"), "{e}");
    }

    /// A hold nobody has honoured is not a hold, here as everywhere else — the
    /// same call `free` makes, so the widget cannot offer an edit the write would
    /// then refuse, nor refuse one it would have allowed.
    #[test]
    fn a_lapsed_hold_does_not_block_a_rewording() {
        let i = item(Some("c1"), Some(1_000));
        assert!(may_edit(&i, 1_000 + HOLD_STALE_MS + 1).is_ok());
    }

    #[test]
    fn a_settled_item_is_history_and_is_not_reworded() {
        let mut i = item(None, None);
        i.settled_at = Some(5_000);
        let e = may_edit(&i, 6_000).unwrap_err();
        assert!(e.contains("put it back first"), "{e}");
    }

    /// Merging on the title is load-bearing, so a rename onto an occupied title
    /// is refused rather than merged: two pending items sharing a title in one
    /// scope is a state nothing else here can produce, and one where the next
    /// agent to meet the thing would second whichever the query reached first.
    #[test]
    fn a_rename_onto_an_occupied_title_is_refused() {
        let mut other = item(None, None);
        other.id = "ffff0000-1111".into();
        other.title = "the sink cannot be edited".into();
        let items = vec![item(None, None), other];
        let me = &items[0];

        assert!(title_taken(&items, me, "the sink cannot be edited").is_some());
        assert!(title_taken(&items, me, "THE SINK CANNOT BE EDITED").is_some());
        assert!(title_taken(&items, me, "something else entirely").is_none());
    }

    /// Leaving your own title alone is not a collision with yourself, which is
    /// what makes fixing only the body possible.
    #[test]
    fn an_item_does_not_collide_with_itself() {
        let items = vec![item(None, None)];
        assert!(title_taken(&items, &items[0], &items[0].title.clone()).is_none());
    }

    /// Scoped like the merge itself. One title in two projects is two findings
    /// about two repositories and always was.
    #[test]
    fn one_title_in_two_projects_is_not_a_collision() {
        let mut other = item(None, None);
        other.id = "ffff0000-1111".into();
        other.project_id = Some("p1".into());
        let items = vec![item(None, None), other];
        assert!(title_taken(&items, &items[0], &items[1].title.clone()).is_none());
    }

    /// A settled item does not hold its title against a rename, for the reason it
    /// does not absorb a fresh drop of the same thing: it is history, and the
    /// thing being back is news.
    #[test]
    fn a_settled_item_does_not_hold_its_title() {
        let mut other = item(None, None);
        other.id = "ffff0000-1111".into();
        other.title = "was dealt with".into();
        other.settled_at = Some(9_000);
        let items = vec![item(None, None), other];
        assert!(title_taken(&items, &items[0], "was dealt with").is_none());
    }

    /// The words in an item stop being the finder's the moment you rewrite them,
    /// and the line above them says who found it. An agent reading a body the
    /// user reworded is being told whose reasoning it is.
    #[test]
    fn the_reading_says_when_you_have_reworded_an_agents_item() {
        let now = 10 * 60_000;
        let mut i = item(None, None);
        i.from_id = Some("c1".into());
        assert!(!render(&i, now, "c2").contains("reworded"));
        i.edited_at = Some(now - 60_000);
        assert!(render(&i, now, "c2").contains("the user reworded this 1m ago"));
    }

    /// Your own item needs no such note — it was your words to begin with, and
    /// saying so on every row you have ever tidied is noise in a reading an agent
    /// pays for.
    #[test]
    fn your_own_item_says_nothing_about_being_reworded() {
        let mut i = item(None, None);
        i.edited_at = Some(1_000);
        assert!(!render(&i, 60_000, "c2").contains("reworded"));
    }
}
