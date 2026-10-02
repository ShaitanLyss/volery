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
//! Five tools, and `done` is the one that makes the others worth having:
//!
//! - `sink` lists and searches it, one line per item. Free, like the board, and
//!   for the same reason. `sink_read` reads the items it names in full.
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
/// Whole items by id. `SINK_` in the constant because `timeline::READ_TOOL`
/// already exists and `tools/lift-roster.ts` flattens every module into one
/// namespace.
pub const SINK_READ_TOOL: &str = "sink_read";

/// How much of an index one `sink` call may print before it stops and says so.
///
/// The index is one line per item, about 110 characters, so this is a little
/// over five hundred items — enough for the whole open pile today (270 on
/// 2026-10-01) with room to grow, and a quarter of what Claude Code accepts in
/// one tool result. It exists because the settled pile only grows, and the
/// bug this file was changed for is exactly a read that returned more than a
/// tool result can hold (sink `5b039f69`: 554,510 characters at wall scope).
const INDEX_BUDGET: usize = 60_000;

/// How much `sink_read` prints in one call. A body is capped at
/// `store::MAX_SINK_BODY` (4,000), so this is twenty full items at the worst;
/// past it the rest are named rather than dropped, for the reason
/// `ask_user`'s question cap went (sink `4b076830`): a cap the reader cannot
/// see is data loss.
const READ_BUDGET: usize = 80_000;

/// How many still-open items one card may have dropped before the receipt says
/// so. **A nudge, not a limit** — it used to refuse at twelve, and on 2026-10-02
/// an orchestrator running five to ten workers on a refactor was refused a real
/// bug and lost it (the item was never written anywhere else). A refusal that
/// costs the finding is the one failure this table exists to prevent, and the
/// thing the cap guarded — a card narrating every thought into the pile — is
/// visible to the user in the Basin and is cheaply `done`. So past this the
/// write still lands and the receipt carries a sentence about the size of the
/// pile; see `pile_note`.
const OPEN_PER_CARD_NUDGE: i64 = 12;

/// The soft half of what `MAX_OPEN_PER_CARD` used to be: a sentence on the
/// receipt of a drop that lands, once this card has a long tail of its own
/// unsettled items. Empty below the threshold, and empty on a merge, which adds
/// no row.
fn pile_note(open_before: i64, merged: bool) -> String {
    if merged || open_before < OPEN_PER_CARD_NUDGE {
        return String::new();
    }
    format!(
        " (This card now has {} unsettled items in the sink. It was written anyway — \
         but if some of them are already dealt with, `done` them so the pile stays one \
         somebody reads.)",
        open_before + 1
    )
}

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
///
/// **This one refuses rather than clipping, and it is the only cap on the wall
/// that does.** Every other capped field here is cut and marked, per
/// `.claude/rules/clipping.md` — but that rule's marker is required to name *a
/// next move*, and at settle time there is no move left to name. The item is
/// being closed by the very call that produced the marker: `put_sink_item`
/// matches `settled_at IS NULL` so a settled item does not absorb a `drop`, and
/// `may_edit` refuses history, so an agent doing as the marker said got a
/// refusal or filed a *new* open item about finished work. `b6bfecba`'s note is
/// 642 stored characters and lost 558 of 957 — the root-cause paragraph of a
/// browser-tools investigation, ending mid-word (sink `78b3d002`).
///
/// The body's marker works and this was copied from it. The difference is not
/// the wording: a body is clipped at **drop** time, while the item is still
/// open, so "file the remainder as its own item" is a thing the caller can do
/// next. Timing relative to the door closing is the whole of it.
///
/// Four shapes were on the table and the next reader will meet them too:
///
/// 1. **Reword the marker** — tell the caller to `drop` the long version *then*
///    `done`. Correct advice, zero code, and still one call too late to take.
/// 2. **Refuse.** Nothing is lost, the caller still holds the whole text, and
///    the refusal's own sentence is followable *at the moment it is read*.
/// 3. **Overflow the excess into the body** as a final voice, then settle.
///    Keeps everything in one call, and quietly makes `done` a write to two
///    fields — which changes what a settled item *is*, a larger decision than
///    this bug warrants.
/// 4. **Raise the number.** Moves it rather than fixing it.
///
/// Taken: **(2), with (1) in the schema rather than in a marker.** Refusing is
/// what this subsystem already chose for the cross-scope twin (`twin_refusal`,
/// f24e6a1), for the reason that holds here too — a refusal is read where a
/// warning is skimmed, and it costs one gesture and loses nothing. And (1) is
/// worth having as well, but a marker is the wrong place to put it: the note
/// property's own description is in front of the agent *before* it composes the
/// call, which is the one moment the advice can still be acted on cheaply.
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
   through `crate::clip`.

   The `paths` list had one too — eight, silently kept from the front — and it
   went for the same reason one layer along. A path list is what lets somebody
   working in a file find the item without reading the whole sink, so dropping
   the ninth is dropping the reader it was written for, and nothing said so: the
   receipt read `dropped`, the item carried eight of the eleven paths the author
   believed they had filed. Same shape as `ask_user` answering five of twelve
   questions and reading as complete (sink `4b076830`). An honest list for a
   change touching a front end, a back end, a test and a manifest is longer than
   eight, and it costs one line of a listing to carry. */

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
             not stop for — bugs seen in passing, tools that should exist, rough edges. \
             Nothing here is about work in flight and nothing expires; an item sits until \
             it is settled. Free, and costs nobody a turn.\n\n\
             Read it when asked what is pending, before working somewhere (search for the \
             file or the subject), or when looking for the next useful thing.\n\n\
             **It answers one line per item, without the bodies.** Pass `query` to search; \
             read the items you want in full with `mcp__skein__sink_read`.\n\n\
             **Nothing here is assigned to you.** A held item is another conversation's — \
             leave it alone. Take one because the user asked or you are already there, not \
             merely because it is unheld.\n\n\
             Each row names its scope after the id: `WALL`, or the project's name. That is \
             part of an item's address — a title alone is not one.",
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
                },
                "query": {
                    "type": "string",
                    "description":
                        "Words that must all appear, in any case, in an item's title, body, \
                         paths or id. \"Quote\" a phrase to keep it together. Best match first."
                }
            }
        }
    })
}

pub fn sink_read_schema() -> Value {
    json!({
        "name": SINK_READ_TOOL,
        "description":
            "Read sink items in full — title, body, files, who dropped it, who holds it, and \
             the settling note if it was dealt with. `mcp__skein__sink` lists and searches \
             one line per item; this is how you read the ones that matter.\n\n\
             Ids come from that listing (the eight characters in brackets are enough). Reads \
             across the whole wall, settled items included, so an id seen anywhere — a \
             commit, a note, another card's message — can be read here.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "items": {
                    "description":
                        "The items to read: ids as `sink` printed them, or exact titles. \
                         A list, or one string with the ids separated by commas.",
                    "anyOf": [
                        { "type": "string" },
                        { "type": "array", "items": { "type": "string" } }
                    ]
                }
            },
            "required": ["items"]
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
             item rather than making a second one, and the receipt says so.\n\n\
             **A title only addresses an item together with its scope**, and `sink`'s \
             listing marks each row with one — `WALL`, or the project's name. To second a \
             `WALL` row you must pass `scope: \"skein\"`; copying the title alone files a \
             project item of the same name instead, which is a second item and not a \
             voice. That is refused rather than done quietly, so if the scopes disagree \
             you will be told which item holds the title and nothing will have been \
             written.",
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
                         repository — and it is what seconding a `WALL` row in the \
                         listing takes, since the voice has to land in the scope the item \
                         is filed under."
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
                    /* The number is interpolated rather than written out, because
                       this sentence is the *only* place the cap is stated before
                       the call rather than after it — see `MAX_NOTE` — and a
                       description that named a stale number would be worse than
                       one that named none. */
                    "description": format!(
                        "What was actually done about it, in a line — the commit, the \
                         fix, or why it turned out not to be a problem. This is all \
                         anybody reading the settled list later will have.\n\n\
                         A sentence or two, not a second body: over {MAX_NOTE} characters \
                         this is **refused** rather than clipped, because settling closes \
                         the item and nothing could add the tail back afterwards. If the \
                         finding is long, `drop` it under this item's exact title first — \
                         that adds it to the item as a further voice — and settle with a \
                         line."
                    )
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
    let query = args.get("query").and_then(Value::as_str).unwrap_or("");

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

    /* One read of the roster for the whole pile rather than one per row. */
    let scopes = Scopes::read(app, &me);
    listing(&items, settled, query, crate::store::now(), caller, &scopes)
}

/// What `sink` answers with: an **index**, one line per item, and never the
/// bodies.
///
/// It used to print every item whole, and at wall scope that was 554,510
/// characters — far past what a tool result can carry, so the client spilled it
/// to a file and the agent had to grep a dump instead of reading the sink (sink
/// `5b039f69`). The bodies are what made it large and they are rarely what a
/// reader wants first: a pile is scanned for what is relevant, and then a few
/// items are read. So the scan is this, and the read is `sink_read`.
///
/// With a `query` the grouping gives way to a ranking, because the question
/// being asked is "which of these is about my thing", and each hit carries a
/// snippet around where its body matched so relevance can be judged without a
/// second call. Without one the groups are as they always were: yours first,
/// then waiting, then held by somebody else.
///
/// Pure, so the lift can execute it: the caller reads the store and the roster.
fn listing(
    items: &[&SinkItem],
    settled: bool,
    query: &str,
    now: i64,
    caller: &str,
    scopes: &Scopes,
) -> String {
    let terms = terms_of(query);
    let mut out = Budget::new();

    if !terms.is_empty() {
        let mut hits: Vec<(usize, &SinkItem)> = items
            .iter()
            .filter_map(|i| score(i, &terms).map(|s| (s, *i)))
            .collect();
        if hits.is_empty() {
            let pile = if settled { "settled" } else { "open" };
            return format!(
                "no {pile} item in this read matches {query:?}. Every word has to appear \
                 somewhere in an item; try fewer or broader words{}.",
                if settled { "" } else { ", or `settled: true` for what was already dealt with" }
            );
        }
        /* Stable, so equal scores keep the store's oldest-first order — the pile's
           own reading, which `.claude/rules/sink.md` argues for. */
        hits.sort_by(|a, b| b.0.cmp(&a.0));
        out.head(&format!("{} match {query:?}, best first:\n\n", hits.len()));
        for (_, i) in hits {
            let snip = snippet(&i.body, &terms)
                .map(|s| format!("  {s}\n"))
                .unwrap_or_default();
            out.entry(&format!("{}{snip}", row(i, now, caller, scopes)));
        }
        return out.finish(true);
    }

    if settled {
        out.head("Already dealt with — do not raise these again unless they are back:\n\n");
        for i in items {
            out.entry(&row(i, now, caller, scopes));
        }
        return out.finish(false);
    }

    /* Yours first, and said out loud, for `do_board`'s reason: an agent that
       sees what it is holding at the top of every read is one that remembers it
       is holding it. */
    let (mine, rest): (Vec<&&SinkItem>, Vec<&&SinkItem>) =
        items.iter().partition(|i| i.held_by.as_deref() == Some(caller));

    if !mine.is_empty() {
        out.head(
            "You are holding these — finish them with `mcp__skein__done`, or put them \
             back with `mcp__skein__take … release: true` if you have stopped:\n\n",
        );
        for i in &mine {
            out.entry(&row(i, now, caller, scopes));
        }
        out.head("\n");
    }

    let (held, open): (Vec<&&SinkItem>, Vec<&&SinkItem>) =
        rest.into_iter().partition(|i| !free(i, now));

    if !open.is_empty() {
        out.head("Waiting, nobody on them:\n\n");
        for i in &open {
            out.entry(&row(i, now, caller, scopes));
        }
    } else if mine.is_empty() {
        out.head("Nothing is waiting — every item is held.\n");
    }
    if !held.is_empty() {
        out.head("\nHeld by another conversation — leave these alone:\n\n");
        for i in &held {
            out.entry(&row(i, now, caller, scopes));
        }
    }
    out.finish(false)
}

/// An index being written against `INDEX_BUDGET`.
///
/// Rows past the budget are counted rather than printed, and `finish` says how
/// many and what to do about it — `.claude/rules/clipping.md`'s two rules, with
/// the cut at a row boundary because a row is the unit a reader acts on.
/// Headers always print, so a group whose rows were all over budget still says
/// it exists.
struct Budget {
    out: String,
    omitted: usize,
}

impl Budget {
    fn new() -> Self {
        Budget { out: String::new(), omitted: 0 }
    }

    fn head(&mut self, s: &str) {
        self.out.push_str(s);
    }

    fn entry(&mut self, s: &str) {
        if self.omitted > 0 || self.out.len() + s.len() > INDEX_BUDGET {
            self.omitted += 1;
        } else {
            self.out.push_str(s);
        }
    }

    fn finish(mut self, searched: bool) -> String {
        if self.omitted > 0 {
            self.out.push_str(&format!(
                "\n**{} more not listed**, to keep this inside one tool result — narrow it \
                 with {}`kind` or `scope: \"project\"`.\n",
                self.omitted,
                if searched { "more words in `query`, " } else { "`query`, " },
            ));
        }
        self.out.push_str(
            "\nRead any of these in full with `mcp__skein__sink_read`, passing their ids.\n",
        );
        self.out
    }
}

/// One line of the index: the address, the kind, how many conversations met
/// it, the title, and whether anybody is on it. No body and no paths — those
/// are what `sink_read` is for, and they are what made the old listing too
/// large to read.
fn row(i: &SinkItem, now: i64, caller: &str, scopes: &Scopes) -> String {
    let voices = if i.voices > 1 {
        format!(" ×{}", i.voices)
    } else {
        String::new()
    };
    let hold = match (&i.held_by, i.held_at) {
        (Some(h), _) if h == caller => " · yours".to_string(),
        (Some(_), Some(at)) if now - at > HOLD_STALE_MS => " · hold lapsed, free to take".into(),
        (Some(h), _) => format!(" · held by {}", crate::relay::handle_of(h)),
        (None, _) => String::new(),
    };
    let settled = match i.settled_at {
        Some(at) => format!(" · settled {}", ago(now - at)),
        None => String::new(),
    };
    format!(
        "- [{}] {} · {}{voices} — {}{hold}{settled}\n",
        short(&i.id),
        scopes.tag_of(i),
        i.kind,
        i.title,
    )
}

/// Fold a string for matching: lowercase, one char for one char, so that a
/// position found in the folded text is the same position in the original.
/// `str::to_lowercase` cannot promise that — `İ` lowers to two chars — and
/// `snippet` cuts the original at a position found in the fold.
fn fold(s: &str) -> Vec<char> {
    s.chars()
        .map(|c| c.to_lowercase().next().unwrap_or(c))
        .collect()
}

/// The words of a query. A `"quoted phrase"` is one term; everything else
/// splits on whitespace. Empty for an empty or all-space query, which means
/// "no search".
/// `fold`, with every run of whitespace collapsed to one space: the shape a
/// body, a phrase and a snippet are all compared in, so a phrase matches across
/// a line wrap and a match always has a snippet to show.
fn fold_flat(s: &str) -> Vec<char> {
    fold(&s.split_whitespace().collect::<Vec<_>>().join(" "))
}

fn terms_of(query: &str) -> Vec<Vec<char>> {
    let mut out = Vec::new();
    for (n, part) in query.split('"').enumerate() {
        if n % 2 == 1 {
            let phrase = fold_flat(part);
            if !phrase.is_empty() {
                out.push(phrase);
            }
        } else {
            out.extend(part.split_whitespace().map(fold));
        }
    }
    out
}

fn contains(hay: &[char], needle: &[char]) -> bool {
    find(hay, needle).is_some()
}

fn find(hay: &[char], needle: &[char]) -> Option<usize> {
    if needle.is_empty() || needle.len() > hay.len() {
        return None;
    }
    hay.windows(needle.len()).position(|w| w == needle)
}

/// How well an item answers a query, or `None` if it does not.
///
/// **Every term must appear somewhere** — in the title, the body, the paths or
/// the id — which is what a reader typing two words means. The score only
/// orders the hits: a term in the title counts three, in the paths two (a path
/// match is somebody naming the file you are about to work in), anywhere else
/// one. Deliberately no cleverer: `.claude/rules/sink.md`'s merge argument holds
/// here too, that a fuzzy match folding two different things together is worse
/// than the miss it saves.
fn score(i: &SinkItem, terms: &[Vec<char>]) -> Option<usize> {
    let title = fold_flat(&i.title);
    let paths = fold_flat(&i.paths);
    let body = fold_flat(&i.body);
    let id = fold(&i.id);
    let mut total = 0;
    for t in terms {
        let s = if contains(&title, t) {
            3
        } else if contains(&paths, t) {
            2
        } else if contains(&body, t) || contains(&id, t) {
            1
        } else {
            return None;
        };
        total += s;
    }
    Some(total)
}

/// About a line of the body around its first match, for judging a hit without
/// reading it. `None` when no term is in the body (it matched on the title or a
/// path, which the row already shows). A preview rather than a cut in
/// `clip.rs`'s sense: the whole body is one `sink_read` away, so it ends in an
/// ellipsis and carries no marker.
fn snippet(body: &str, terms: &[Vec<char>]) -> Option<String> {
    const BEFORE: usize = 60;
    const WIDTH: usize = 160;
    let flat: Vec<char> = body.split_whitespace().collect::<Vec<_>>().join(" ").chars().collect();
    let folded = fold_flat(body);
    let at = terms.iter().filter_map(|t| find(&folded, t)).min()?;
    let start = at.saturating_sub(BEFORE);
    let end = (start + WIDTH).min(flat.len());
    let mut s = String::new();
    if start > 0 {
        s.push('…');
    }
    s.extend(&flat[start..end]);
    if end < flat.len() {
        s.push('…');
    }
    Some(s)
}

/* ── reading in full ──────────────────────────────────────────────────────── */

/// The other half of the index. Reads across the **whole wall, open and
/// settled**, for `do_take`'s reason one step further: an id an agent was handed
/// — by a commit message, a note, another card — is one it should be able to
/// read, whichever scope it is filed under and whether or not it is still open.
fn do_read(app: &AppHandle, caller: &str, args: &Value) -> String {
    let me = reader(app, caller);
    let wanted = addresses(args.get("items").or_else(|| args.get("item")));
    let wanted: Vec<&str> = wanted.iter().map(String::as_str).collect();
    if wanted.is_empty() {
        return "name the items to read by their ids — `mcp__skein__sink` lists them".into();
    }
    let mut items = match visible(app, &me, true, false) {
        Ok(i) => i,
        Err(e) => return format!("could not read the sink: {e}"),
    };
    match visible(app, &me, true, true) {
        Ok(s) => items.extend(s),
        Err(e) => return format!("could not read the sink: {e}"),
    }
    let scopes = Scopes::read(app, &me);
    read_out(&items, &wanted, crate::store::now(), caller, &scopes)
}

/// What `items` names. A list is taken as it is. A string is split on commas
/// **only when every piece looks like an id**: 163 of 435 titles in the store
/// on 2026-10-02 contain a comma, and the schema accepts an exact title, so a
/// title passed as a string has to arrive whole. Newlines always split.
fn addresses(v: Option<&Value>) -> Vec<String> {
    let looks_like_id = |p: &str| {
        p.len() >= 4 && p.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
    };
    let mut out: Vec<String> = Vec::new();
    match v {
        Some(Value::Array(a)) => out.extend(a.iter().filter_map(Value::as_str).map(str::to_string)),
        Some(Value::String(s)) => {
            for line in s.lines() {
                let pieces: Vec<&str> = line.split(',').map(str::trim).collect();
                if pieces.len() > 1 && pieces.iter().all(|p| p.is_empty() || looks_like_id(p)) {
                    out.extend(pieces.iter().map(|p| p.to_string()));
                } else {
                    out.push(line.to_string());
                }
            }
        }
        _ => {}
    }
    out.into_iter()
        .map(|a| a.trim().to_string())
        .filter(|a| !a.is_empty())
        .collect()
}

/// Pure half of `sink_read`: resolve every address, print what it names in
/// full, and say plainly what it could not. Each address is answered on its
/// own, so one typo does not cost the rest of the call.
fn read_out(items: &[SinkItem], wanted: &[&str], now: i64, caller: &str, scopes: &Scopes) -> String {
    let mut out = String::new();
    let mut notes: Vec<String> = Vec::new();
    let mut unread: Vec<String> = Vec::new();
    let mut seen: Vec<&str> = Vec::new();
    for want in wanted {
        /* Several hits is not a refusal here, unlike `take` and `done`: a read
           changes nothing, and the likeliest cause is legitimate — a settled
           item does not absorb a re-drop, so an open item and a settled one
           can share a title. So every hit is printed, and said. */
        let hits = match resolve(items, want) {
            Pick::One(i) => vec![i],
            Pick::Several(hits) => {
                notes.push(format!(
                    "{} items answer to {want:?}, so all of them are printed: {}.",
                    hits.len(),
                    hits.iter()
                        .map(|i| format!("[{}] filed {}", short(&i.id), scopes.of(i)))
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
                hits
            }
            Pick::None => {
                notes.push(format!(
                    "nothing answers to {want:?} — search with `mcp__skein__sink` and `query`."
                ));
                continue;
            }
        };
        for i in hits {
            if seen.contains(&i.id.as_str()) {
                continue;
            }
            seen.push(&i.id);
            let text = render(i, now, caller, scopes);
            if !out.is_empty() && out.len() + text.len() > READ_BUDGET {
                unread.push(short(&i.id));
                continue;
            }
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(&text);
        }
    }
    if !unread.is_empty() {
        notes.push(format!(
            "**{} more not printed**, to keep this inside one tool result: {} — read them \
             in a second call.",
            unread.len(),
            unread.join(", ")
        ));
    }
    for n in notes {
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(&n);
        out.push('\n');
    }
    out
}

/// One row of a listing.
///
/// The scope goes first, after the id, because that is the half of an item's
/// address the listing used not to carry at all — and the reason the sink had
/// six twins in it. See `scope_tag` for what the column costs and why the wall
/// shouts.
fn render(i: &SinkItem, now: i64, caller: &str, scopes: &Scopes) -> String {
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
        "- [{}] {} · {}{voices} — {}\n  {}{files}\n  dropped by {who}, {}{hold}{edited}{settled}\n",
        short(&i.id),
        scopes.tag_of(i),
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
    /* Counted before the write so the receipt can say it, and never a reason to
       refuse: see `OPEN_PER_CARD_NUDGE`. */
    let open_before = crate::store::sink_dropped_count(&conn, caller);
    /* The scope the merge uses and the scope the read uses are not the same one,
       and this is where that stops being silent.

       `sink` at project scope serves a union — this project's items and the
       wall-wide ones — while `put_sink_item` merges within one `project_id`. So
       an agent that reads a wall-wide item in project scope, agrees with it and
       drops under the same title does not second it: it files a project twin and
       is told "dropped into the project sink as […]" with exactly the confidence
       of a fresh finding. Six of those in `skein.db` by 2026-09-10, the last one
       made by a card copying a title byte-for-byte out of the listing (sink
       `23f5f762`).

       `title_taken`'s rule is unchanged and its argument still stands — two
       items with one title in two *different projects* are two findings about
       two repositories. What is asked here is narrower: only the one pair of
       scopes the union puts in front of a reader, wall-wide against the project
       the drop is landing in. A third project's identically-titled item is not
       consulted and never was.

       Asked only when this scope has no match of its own, so a real merge still
       wins: the question is what to do when there is *nothing* to merge with
       here and something to merge with one scope over. See `.claude/rules/sink.md`
       for why that refuses rather than warns. */
    let across = if wall { me.project_id.as_deref() } else { None };
    if across != project_id.as_deref()
        && crate::store::sink_titled(&conn, &title, project_id.as_deref()).is_none()
    {
        if let Some(other) = crate::store::sink_titled(&conn, &title, across) {
            return twin_refusal(&other, &title, wall);
        }
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
            let cuts = format!(
                "{}{}",
                clipped_note(&title_cut, p.body_omitted),
                pile_note(open_before, p.merged)
            );
            if p.merged {
                let voices = if p.voices > 1 {
                    format!(" {} conversations have now met it.", p.voices)
                } else {
                    String::new()
                };
                /* Which scope was searched, because the merge is scoped and the
                   read is not: an item with this title can be sitting wall-wide
                   while this drop lands on a project one, or the other way
                   round. Saying which was matched is what lets an agent notice
                   that. See sink `23f5f762`. */
                format!(
                    "{title:?} was already in the {} sink, so this went onto that item \
                     rather than making a second one — anything your words added is on \
                     it now.{voices} It is [{}]. Tell the user you seconded an existing \
                     item rather than raising a new one.{cuts}",
                    if wall { "wall-wide" } else { "project" },
                    short(&p.id)
                )
            } else {
                format!(
                    "dropped into the {} sink as [{}]: {title:?}. It will outlive this \
                     conversation. Nobody is assigned to it — if you are about to deal \
                     with it yourself, `mcp__skein__take` it first.{cuts}",
                    if wall { "wall-wide" } else { "project" },
                    short(&p.id)
                )
            }
        }
    }
}

/// One title, two scopes: nothing dropped, and the item that holds the title
/// named.
///
/// Pure, because the words are the whole of the fix — a refusal an agent cannot
/// act on is the bug with better manners. So it says four things and no more:
/// that nothing happened, which id holds the title and where, the one argument
/// that seconds it, and the one that files it anyway. `Pick::Several`'s shape
/// (`ambiguous`) one door along, and `title_taken`'s argument in its own words.
fn twin_refusal(other: &SinkItem, title: &str, wall: bool) -> String {
    let (theirs, mine, escape) = if wall {
        (
            "under this project",
            "the wall-wide sink",
            "drop the same words again without `scope`",
        )
    } else {
        (
            "wall-wide",
            "this project's sink",
            "drop the same words again with `scope: \"skein\"`",
        )
    };
    format!(
        "{title:?} is already in the sink as [{}], filed {theirs} — and this drop was for \
         {mine}, which is a different scope, so it would have made a second item under \
         that title rather than adding your voice to that one. Nothing was dropped. To \
         second it, {escape}. If this really is a separate finding, give it a title that \
         says how it differs and say to the user that you did — a sink where one title \
         answers to two items is one nothing can be addressed in (sink `23f5f762`).",
        short(&other.id)
    )
}

/* ── taking and settling ──────────────────────────────────────────────────── */

/// The eight characters an item is spoken of by — the head `render` prints, and
/// the head `resolve` takes back.
fn short(id: &str) -> String {
    id.chars().take(8).collect()
}

/// What a written address turned out to mean.
///
/// `Several` is the arm this grew for, and it is not a theoretical one: `take`
/// and `done` read across the whole wall and resolve by title as well as by id,
/// and a title is only unique *within a scope* — so two open items can and do
/// answer to one string (sink `23f5f762`). Guessing between them is the worst
/// available answer, because both spellings of the guess read identically in
/// the receipt: settling the twin and settling the original produce the same
/// sentence. `title_taken` already refuses rather than guesses, on the argument
/// that "being told which item holds the title costs you one gesture and loses
/// nothing", and that argument is unchanged here.
enum Pick<'a> {
    One(&'a SinkItem),
    Several(Vec<&'a SinkItem>),
    None,
}

/// Find the item an agent means. Full id, then its short head, then the exact
/// title — the same ladder `relay::resolve` and `do_unpost` walk, because the
/// agent was shown both spellings and either is a fair thing to type back.
///
/// Each rung past the first can match more than one row: a four-character
/// fragment is a prefix rather than a name, and a title is unique only within a
/// scope. So each rung collects, and a rung that finds two says so rather than
/// handing back whichever the query reached first. Kept pure — the caller names
/// the scopes, because that is the half that needs the store.
fn resolve<'a>(items: &'a [SinkItem], want: &str) -> Pick<'a> {
    let want = want.trim();
    if let Some(i) = items.iter().find(|i| i.id == want) {
        return Pick::One(i);
    }
    let rungs = [
        items
            .iter()
            .filter(|i| want.len() >= 4 && i.id.starts_with(want))
            .collect::<Vec<_>>(),
        items
            .iter()
            .filter(|i| i.title.eq_ignore_ascii_case(want))
            .collect::<Vec<_>>(),
    ];
    for hits in rungs {
        match hits.len() {
            0 => continue,
            1 => return Pick::One(hits[0]),
            _ => return Pick::Several(hits),
        }
    }
    Pick::None
}

/// Where an item is filed — the three readings anything here can have of a
/// row's scope, and the one place that decides what they are.
///
/// Two spellings of it exist below and they are one *register* apart rather than
/// one vocabulary apart, which is why they both come off this match: prose for
/// a receipt (`scope_name`), a column for a listing row (`scope_tag`). A fourth
/// territory reading cannot be added to one and forgotten in the other, and an
/// agent that reads a row and then reads a receipt is being told the same thing
/// twice rather than two things that happen to agree.
enum Filed<'a> {
    Wall,
    /// Under the territory the reading card is standing in.
    Here(Option<&'a str>),
    /// Under some other project. Reachable from a `scope: "skein"` read, and
    /// from `take`/`done`, which resolve across the whole wall.
    Elsewhere(Option<&'a str>),
}

fn filed<'a>(item_project: Option<&str>, mine: Option<&str>, name: Option<&'a str>) -> Filed<'a> {
    match item_project {
        None => Filed::Wall,
        Some(p) if Some(p) == mine => Filed::Here(name),
        Some(_) => Filed::Elsewhere(name),
    }
}

/// Where an item is filed, in the words a receipt uses.
///
/// Pure, so the three arms are testable; `Scopes` is the thin half that knows
/// what the wall's territories are called. Always reads as `filed {…}`.
fn scope_name(item_project: Option<&str>, mine: Option<&str>, name: Option<&str>) -> String {
    match filed(item_project, mine, name) {
        Filed::Wall => "wall-wide".into(),
        /* No name needed — prose has "this" to lean on, where a column does
           not. */
        Filed::Here(_) => "under this project".into(),
        Filed::Elsewhere(Some(n)) => format!("under the {n} project"),
        Filed::Elsewhere(None) => "under another project".into(),
    }
}

/// The same three readings, in the width a **listing row** can afford.
///
/// This is the cause of sink `23f5f762` rather than a nicety. `sink` at project
/// scope serves a union — this project's items and the wall-wide ones — and the
/// merge `drop` performs is one scope only, so a title copied out of that
/// listing is not the address the copier thinks it is. Six twins in `skein.db`
/// by 2026-09-10, and the sixth was made by a card copying a title
/// byte-for-byte out of this very listing in order to second an item.
///
/// Two things it is spending characters on, both deliberately:
///
/// - **The wall reads in caps.** A listing at project scope holds exactly two
///   kinds of row and the difference between them is the whole point, so it has
///   to survive being skimmed; `WALL` against a lowercase project name does,
///   where `wall` against `skein` does not. This is a tool result read by a
///   model rather than prose on the wall, so the house's lowercase register is
///   not what is being served here — legibility is.
/// - **Nothing longer.** Every row of every read pays for it, and a full sink
///   already overflows a tool result. One word is the budget.
fn scope_tag(item_project: Option<&str>, mine: Option<&str>, name: Option<&str>) -> String {
    match filed(item_project, mine, name) {
        Filed::Wall => "WALL".into(),
        Filed::Here(Some(n)) | Filed::Elsewhere(Some(n)) => n.into(),
        /* A project the roster has no name for. Says which of the two it is,
           which is all the row is claiming. */
        Filed::Here(None) | Filed::Elsewhere(None) => "project".into(),
    }
}

/// What a receipt or a listing row needs to say where a row lives: this card's
/// own territory, and the wall's territories by name.
///
/// Read once per call rather than per row — `do_sink` renders one of these
/// against a whole pile — and by everything except `drop`, which writes into a
/// scope it chose itself and can say so without asking.
struct Scopes {
    mine: Option<String>,
    names: Vec<(String, String)>,
}

impl Scopes {
    fn read(app: &AppHandle, me: &Reader) -> Scopes {
        let names = app
            .try_state::<Store>()
            .and_then(|store| {
                let conn = store.0.lock().ok()?;
                crate::store::projects(&conn).ok()
            })
            .unwrap_or_default()
            .into_iter()
            .map(|p| (p.id, p.name))
            .collect();
        Scopes { mine: me.project_id.clone(), names }
    }

    /// The territory's name, if the roster has one for it.
    fn named(&self, item: &SinkItem) -> Option<&str> {
        item.project_id.as_deref().and_then(|p| {
            self.names
                .iter()
                .find(|(id, _)| id == p)
                .map(|(_, n)| n.as_str())
        })
    }

    /// Prose, for a receipt: `filed under the nova project`.
    fn of(&self, item: &SinkItem) -> String {
        scope_name(item.project_id.as_deref(), self.mine.as_deref(), self.named(item))
    }

    /// One word, for a listing row. See `scope_tag`.
    fn tag_of(&self, item: &SinkItem) -> String {
        scope_tag(item.project_id.as_deref(), self.mine.as_deref(), self.named(item))
    }
}

/// Two items answer to one string, so neither is touched.
///
/// It names both, with the scope each is filed under, because the scope is
/// usually the whole of the difference — a wall-wide original and the project
/// twin a re-drop made of it — and because an agent that can see which is which
/// can pick without a second read of the sink.
fn ambiguous(hits: &[&SinkItem], want: &str, scopes: &Scopes) -> String {
    format!(
        "{} items answer to {want:?}, so nothing was touched — name the one you mean by \
         its id: {}. Two open items under one title is a scope mismatch rather than \
         something you did (sink `23f5f762`); if you did not expect a second one, say so \
         to the user.",
        hits.len(),
        hits.iter()
            .map(|i| format!("[{}] filed {}, {:?}", short(&i.id), scopes.of(i), i.title))
            .collect::<Vec<_>>()
            .join("; ")
    )
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
    let scopes = Scopes::read(app, &me);
    let item = match resolve(&items, want) {
        Pick::One(i) => i,
        Pick::Several(hits) => return ambiguous(&hits, want, &scopes),
        Pick::None => return not_found(&items, want),
    };
    let id = short(&item.id);
    let scope = scopes.of(item);
    let now = crate::store::now();

    if release {
        if item.held_by.as_deref() != Some(caller) {
            return match &item.held_by {
                Some(h) => format!(
                    "[{id}] {:?}, filed {scope}, is held by {} — not by you, so there is \
                     nothing to put back.",
                    item.title,
                    crate::relay::handle_of(h)
                ),
                None => format!(
                    "[{id}] {:?}, filed {scope}, was not held by anyone.",
                    item.title
                ),
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
                "put [{id}] back — {:?}, filed {scope}. It is waiting for whoever picks it \
                 up next; if you got part of the way, `mcp__skein__drop` what you learned \
                 so that is not lost too.",
                item.title
            );
        }
        return format!("[{id}] {:?} had already moved on.", item.title);
    }

    if item.held_by.as_deref() == Some(caller) {
        let store = app.state::<Store>();
        let Ok(conn) = store.0.lock() else {
            return "the store is unavailable".into();
        };
        crate::store::touch_sink_hold(&conn, &item.id, caller);
        drop(conn);
        changed(app, item.project_id.clone());
        return format!(
            "you already hold [{id}] — {:?}, filed {scope}. The hold is fresh again.",
            item.title
        );
    }

    if !free(item, now) {
        let who = item
            .held_by
            .as_deref()
            .map(crate::relay::handle_of)
            .unwrap_or_default();
        return format!(
            "[{id}] {:?}, filed {scope}, is held by {who}, who said so {}. Leave it to \
             them and tell the user that is why you did not start it — if it genuinely \
             needs two of you, message {who} rather than working over them.",
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
             of them is an item no other conversation will touch. Finish one with \
             `mcp__skein__done` or put it back before taking this."
        );
    }
    /* Conditional on the hold we read, so two cards claiming this in the same
       instant cannot both be told they have it — see `store::hold_sink_item`. */
    let ok = crate::store::hold_sink_item(&conn, &item.id, Some(caller), item.held_by.as_deref());
    drop(conn);
    if !ok {
        return format!(
            "[{id}] {:?} was taken by another conversation a moment before you — leave it \
             to them.",
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
        "you are holding [{id}] — {:?}, filed {scope}.{was} No other conversation will \
         start it while you have it. `mcp__skein__done` when it is fully addressed, or \
         `mcp__skein__take … release: true` the moment you stop.",
        item.title
    )
}

fn do_done(app: &AppHandle, caller: &str, args: &Value) -> String {
    let me = reader(app, caller);
    let Some(want) = args.get("item").and_then(Value::as_str) else {
        return "name the item by its id or its exact title".into();
    };
    /* Measured, not clipped — the argument is beside `MAX_NOTE` and the short
       version is that a clip here has no remedy to name. `clip::keep` is still
       what does the measuring, because it is also what takes the impossible
       characters out (`.claude/rules/clipping.md`), and its `total` is the
       length *after* that scrub, which is the number every other cap on this
       wall compares against. Nothing is refused here, only counted: the refusal
       waits until the item is resolved, so it can name what to `drop` under. */
    let note = args
        .get("note")
        .and_then(Value::as_str)
        .map(|n| crate::clip::keep(n.trim(), MAX_NOTE))
        .filter(|c| !c.kept.is_empty());

    let items = match visible(app, &me, true, false) {
        Ok(i) => i,
        Err(e) => return format!("could not read the sink: {e}"),
    };
    let scopes = Scopes::read(app, &me);
    let item = match resolve(&items, want) {
        Pick::One(i) => i,
        Pick::Several(hits) => return ambiguous(&hits, want, &scopes),
        Pick::None => return not_found(&items, want),
    };
    let id = short(&item.id);
    let scope = scopes.of(item);
    let now = crate::store::now();

    /* Somebody else's live hold is a refusal rather than a warning. `done` on an
       item another card is in the middle of is either two agents on one job — in
       which case the news the user needs is the collision, not the tick — or an
       agent settling work it did not do. Both are worse than being told no. A
       hold that has gone stale is not a hold, so that case falls through. */
    if let Some(h) = &item.held_by {
        if h != caller && !hold_stale(item, now) {
            return format!(
                "[{id}] {:?}, filed {scope}, is held by {} — they are dealing with it, so \
                 this is not yours to take down. If you have just done the same work, say \
                 so to the user and message {} rather than settling it over them.",
                item.title,
                crate::relay::handle_of(h),
                crate::relay::handle_of(h)
            );
        }
    }

    /* After the hold, before the write. After, because an item somebody else is
       holding is not yours to settle however long your note is, and the
       collision is the more urgent news. Before, because this is the last
       moment the door is still open — which is the entire bug. */
    if let Some(cut) = note.as_ref().filter(|c| c.happened()) {
        return long_note_refusal(item, &id, &scope, cut.total);
    }

    let store = app.state::<Store>();
    let Ok(conn) = store.0.lock() else {
        return "the store is unavailable".into();
    };
    let kept = note.as_ref().map(|c| c.kept.as_str());
    let ok = crate::store::settle_sink_item(&conn, &item.id, kept);
    drop(conn);
    if !ok {
        return format!("[{id}] {:?} was already settled.", item.title);
    }
    changed(app, item.project_id.clone());
    let asked = if note.is_none() {
        " It is kept with no note on it, which is a thin record — say what you did about \
         it next time."
    } else {
        ""
    };
    /* The id and the scope, not the title, are what makes this checkable. This
       receipt named only the title until 2026-09-10, and settling one of two
       identically-titled items produced a sentence indistinguishable from
       settling the other — so the outcome had to be verified against `skein.db`
       by hand. See sink `23f5f762` and the note on `Pick`. */
    format!(
        "took [{id}] out of the sink — {:?}, filed {scope}.{asked} It is kept rather than \
         deleted, so the user can put it back if it turns out not to be finished.",
        item.title
    )
}

/// A note too long to be a note, refused with the door still open.
///
/// The whole of the design is beside `MAX_NOTE`. What this has to get right is
/// that the next move it names is one the caller can make *now* — so it names
/// the door that is open rather than the two that are not: the item has not
/// been settled, so `drop` under this exact title still merges, and a merge on
/// an open item appends the words as a further voice (`store::put_sink_item`).
/// It gives the title back verbatim because that is what the merge matches on,
/// and the scope word because the merge is scoped where the read is not — a
/// wall-wide item re-dropped without `scope` lands as a project twin, which is
/// the accident `twin_refusal` exists for and would be a rude way to meet it.
fn long_note_refusal(item: &SinkItem, id: &str, scope: &str, total: usize) -> String {
    let escape = if item.project_id.is_none() {
        " with `scope: \"skein\"`, since it is filed wall-wide"
    } else {
        ""
    };
    format!(
        "[{id}] {:?}, filed {scope}, was **not** settled and nothing was written — the note \
         is {total} characters and a note may be {MAX_NOTE}. You still have the whole of it, \
         which is why this refuses rather than storing three quarters: settling is the one \
         write that closes the door behind itself, so a clipped note's tail could not be \
         made good afterwards by anything.\n\n\
         A note is a sentence or two on what happened. The long version belongs in the \
         item's own words, and the item is still open, so that is still possible: call \
         `mcp__skein__drop` with this exact title{escape} and the long text as the body — it \
         will be added to this item as a further voice rather than making a second one — and \
         then call `mcp__skein__done` again with a line.",
        item.title,
    )
}

fn not_found(items: &[SinkItem], want: &str) -> String {
    if items.is_empty() {
        return "there is nothing in the sink.".into();
    }
    format!(
        "no item called {want:?}. Read `mcp__skein__sink` for the ids — the ones there \
         now are: {}",
        items
            .iter()
            .take(8)
            .map(|i| format!("[{}] {:?}", short(&i.id), i.title))
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
    list.join("\n")
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
                short(&other.id)
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

/// Drive one of the sink's tools by hand, as a named card.
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
        SINK_READ_TOOL => Some(do_read(app, conversation_id, args)),
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

    /// A long pile is a sentence on the receipt and never a refusal: the cap
    /// that used to be here lost an orchestrator's real bug on 2026-10-02.
    #[test]
    fn a_long_pile_is_told_and_never_refused() {
        assert_eq!(pile_note(0, false), "");
        assert_eq!(pile_note(OPEN_PER_CARD_NUDGE - 1, false), "");
        let note = pile_note(OPEN_PER_CARD_NUDGE, false);
        assert!(note.contains(&format!("{} unsettled items", OPEN_PER_CARD_NUDGE + 1)), "{note}");
        assert!(note.contains("written anyway"), "{note}");
        /* A merge adds no row, so it has nothing to say about the pile. */
        assert_eq!(pile_note(OPEN_PER_CARD_NUDGE + 5, true), "");
    }

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

    /// A roster with one territory on it, named — enough for a row to be
    /// rendered by a test that is not about the scope column.
    fn scopes() -> Scopes {
        Scopes {
            mine: Some("p1".into()),
            names: vec![("p1".into(), "skein".into())],
        }
    }

    /// The id of the one item `resolve` picked, for the tests that only care
    /// that it picked one.
    fn one<'a>(items: &'a [SinkItem], want: &str) -> Option<&'a str> {
        match resolve(items, want) {
            Pick::One(i) => Some(&i.id),
            _ => None,
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
        assert!(one(&items, "abcd1234-0000").is_some());
        assert!(one(&items, "abcd").is_some());
        assert!(one(&items, "ASK_USER TIMES OUT IN A NON-INTERACTIVE SESSION").is_some());
        assert!(matches!(resolve(&items, "nothing like it"), Pick::None));
    }

    /// Three characters is not enough of an id to act on. An agent that typed a
    /// fragment should be told what is there rather than handed whichever item
    /// happened to start with it.
    #[test]
    fn too_short_a_fragment_matches_nothing() {
        let items = vec![item(None, None)];
        assert!(matches!(resolve(&items, "abc"), Pick::None));
    }

    /* ── two items answering to one string ────────────────────────────────── */

    /// The whole of sink `23f5f762`'s second face. `drop` merges within a scope
    /// and `sink` reads across the union, so a wall-wide item and a project one
    /// can carry the same title — and then `done` resolving that title picked
    /// whichever the query reached first and said only the title back, so the
    /// two outcomes were indistinguishable from the receipt. Refused now, the
    /// way `title_taken` refuses rather than guessing.
    #[test]
    fn two_items_under_one_title_are_refused_rather_than_guessed_between() {
        let wall = item(None, None);
        let mut mine = item(None, None);
        mine.id = "ffff0000-1111".into();
        mine.project_id = Some("p1".into());
        let items = vec![wall, mine];

        let Pick::Several(hits) = resolve(&items, &items[0].title.clone()) else {
            panic!("one title over two scopes has to refuse");
        };
        assert_eq!(hits.len(), 2);

        let scopes = Scopes {
            mine: Some("p1".into()),
            names: vec![("p1".into(), "skein".into())],
        };
        let msg = ambiguous(&hits, "ask_user times out", &scopes);
        assert!(msg.contains("abcd1234"), "{msg}");
        assert!(msg.contains("ffff0000"), "{msg}");
        assert!(msg.contains("wall-wide"), "{msg}");
        assert!(msg.contains("this project"), "{msg}");
        assert!(msg.contains("nothing was touched"), "{msg}");
    }

    /// An id is unique, so a full one is answerable even where the title is not.
    /// This is the escape the refusal above tells the agent to take.
    #[test]
    fn a_full_id_still_answers_where_the_title_is_ambiguous() {
        let wall = item(None, None);
        let mut mine = item(None, None);
        mine.id = "ffff0000-1111".into();
        mine.project_id = Some("p1".into());
        let items = vec![wall, mine];
        assert_eq!(one(&items, "ffff0000-1111"), Some("ffff0000-1111"));
        assert_eq!(one(&items, "ffff"), Some("ffff0000-1111"));
    }

    /// A fragment is a prefix rather than a name, so it has the same exposure —
    /// four characters of a uuid are not a promise of uniqueness.
    #[test]
    fn an_ambiguous_fragment_is_refused_too() {
        let mut a = item(None, None);
        a.id = "abcd0000-1111".into();
        let mut b = item(None, None);
        b.id = "abcd9999-2222".into();
        b.title = "something else".into();
        let items = vec![a, b];
        assert!(matches!(resolve(&items, "abcd"), Pick::Several(_)));
        assert_eq!(one(&items, "abcd0"), Some("abcd0000-1111"));
    }

    /// The three readings a receipt has of where a row lives. The third is the
    /// one that matters: `take` and `done` read the whole wall, so the row they
    /// touched can be filed under a territory this card is not standing in, and
    /// saying "this project" there would be a lie in the direction that hides
    /// the mistake.
    #[test]
    fn a_receipt_says_which_scope_the_row_it_touched_is_filed_under() {
        assert_eq!(scope_name(None, Some("p1"), None), "wall-wide");
        assert_eq!(scope_name(Some("p1"), Some("p1"), Some("skein")), "under this project");
        assert_eq!(scope_name(Some("p2"), Some("p1"), Some("nova")), "under the nova project");
        assert_eq!(scope_name(Some("p2"), Some("p1"), None), "under another project");
    }

    /* ── the scope on every row of the listing ────────────────────────────── */

    /// The same three readings in a column, which is what the *cause* of sink
    /// `23f5f762` wanted: a project read is a union of two scopes, so a row that
    /// does not say which one it came from is a row whose title is not an
    /// address.
    #[test]
    fn a_listing_row_says_which_scope_it_came_from_in_one_word() {
        assert_eq!(scope_tag(None, Some("p1"), None), "WALL");
        assert_eq!(scope_tag(Some("p1"), Some("p1"), Some("skein")), "skein");
        assert_eq!(scope_tag(Some("p2"), Some("p1"), Some("nova")), "nova");
        assert_eq!(scope_tag(Some("p2"), Some("p1"), None), "project");
    }

    /// Skimmable, which is the whole job: the two kinds of row a project read
    /// holds have to differ by more than their spelling. Caps is what does
    /// that, and it costs no characters.
    #[test]
    fn the_wall_and_a_project_do_not_look_alike() {
        let wall = scope_tag(None, Some("p1"), Some("skein"));
        let mine = scope_tag(Some("p1"), Some("p1"), Some("skein"));
        assert_ne!(wall, mine);
        assert!(wall.chars().all(|c| c.is_uppercase()), "{wall}");
        assert!(mine.chars().all(|c| !c.is_uppercase()), "{mine}");
        assert!(wall.len() <= 8 && mine.len() <= 32, "a column, not a sentence");
    }

    /// And it is actually on the row. `render` is where the six twins were
    /// made — an agent read this line, copied the title out of it and dropped
    /// under it — so the assertion is against the rendered row rather than
    /// against `scope_tag` alone.
    #[test]
    fn the_rendered_row_carries_the_scope_beside_the_id() {
        let scopes = scopes();
        let row = render(&item(None, None), 0, "nobody", &scopes);
        assert!(row.starts_with("- [abcd1234] WALL · bug — "), "{row}");

        let mut mine = item(None, None);
        mine.project_id = Some("p1".into());
        let row = render(&mine, 0, "nobody", &scopes);
        assert!(row.starts_with("- [abcd1234] skein · bug — "), "{row}");
    }

    /* ── the drop that would have made a twin ─────────────────────────────── */

    /// The refusal has to be *actionable*, which is the whole difference between
    /// it and the bug it replaces: a warning that creates the twin anyway is the
    /// same twin with better manners. So it names the id that holds the title,
    /// says where that item is filed, says nothing was written, and gives the
    /// one argument that seconds it.
    #[test]
    fn a_cross_scope_drop_is_refused_with_the_id_that_holds_the_title() {
        let held = item(None, None);
        let msg = twin_refusal(&held, &held.title, false);
        assert!(msg.contains("[abcd1234]"), "{msg}");
        assert!(msg.contains("filed wall-wide"), "{msg}");
        assert!(msg.contains("Nothing was dropped"), "{msg}");
        assert!(msg.contains(r#"`scope: "skein"`"#), "{msg}");
    }

    /// And the other direction, which is the same hole read from the other end:
    /// a wall-wide drop over an open item in this project. The escape is the
    /// absence of the argument rather than a value of it, so it cannot be the
    /// same sentence with a word swapped.
    #[test]
    fn the_refusal_names_the_other_scope_when_the_drop_is_the_wall_wide_one() {
        let mut held = item(None, None);
        held.project_id = Some("p1".into());
        let msg = twin_refusal(&held, &held.title, true);
        assert!(msg.contains("filed under this project"), "{msg}");
        assert!(msg.contains("without `scope`"), "{msg}");
        assert!(!msg.contains(r#"with `scope: "skein"`"#), "{msg}");
    }

    /// The refusal a clipped note replaced, and the only thing that says it is
    /// a refusal rather than a cut. Every needle here is load-bearing: the
    /// count, so the caller knows how far over it went; "not settled", so it
    /// cannot be read as a warning after the fact; and the `drop` under this
    /// **exact title**, which is the one door still open at this moment and the
    /// whole of why the old marker's advice could not be taken (sink
    /// `78b3d002`).
    #[test]
    fn an_over_long_note_is_refused_with_a_door_still_open() {
        let it = item(None, None);
        let msg = long_note_refusal(&it, "abcd1234", "wall-wide", 1_500);
        assert!(msg.contains("[abcd1234]"), "{msg}");
        assert!(msg.contains("not** settled"), "{msg}");
        assert!(msg.contains("1500 characters"), "{msg}");
        assert!(msg.contains("400"), "{msg}");
        assert!(msg.contains("`mcp__skein__drop`"), "{msg}");
        assert!(msg.contains("exact title"), "{msg}");
        assert!(msg.contains(&it.title), "{msg}");
    }

    /// A wall-wide item needs `scope: "skein"` on the re-drop or the merge
    /// lands in the caller's project as a twin, and a project item must **not**
    /// be told to pass it. Same asymmetry `twin_refusal` has, for the same
    /// reason, and stated separately because one message with a word swapped is
    /// exactly how that one would have gone wrong.
    #[test]
    fn the_re_drop_names_the_scope_only_when_the_item_is_wall_wide() {
        let wall = item(None, None);
        assert!(
            long_note_refusal(&wall, "abcd1234", "wall-wide", 900)
                .contains(r#"`scope: "skein"`"#),
            "a wall-wide item must say so"
        );
        let mut mine = item(None, None);
        mine.project_id = Some("p1".into());
        assert!(
            !long_note_refusal(&mine, "abcd1234", "under this project", 900)
                .contains(r#"`scope: "skein"`"#),
            "a project item must not be told to file wall-wide"
        );
    }

    /// The cap has to be said *before* the call as well as in the refusal,
    /// since that is the one reading of it an agent can still act on cheaply —
    /// and it has to be the real number. A description naming a stale cap is
    /// worse than one naming none: the agent would compose to fit it and be
    /// refused anyway, with no idea why.
    #[test]
    fn the_note_property_states_the_cap_and_the_way_round_it() {
        let d = done_schema();
        let note = d["inputSchema"]["properties"]["note"]["description"]
            .as_str()
            .expect("note has a description");
        assert!(note.contains(&MAX_NOTE.to_string()), "{note}");
        assert!(note.contains("refused"), "{note}");
        assert!(note.contains("exact title"), "{note}");
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
        /* All of them. There was a cap of eight that kept the first eight
           silently, which drops the reader the ninth path was written for —
           the same shape as `ask_user` answering five of twelve questions and
           reading as complete (sink `4b076830`). */
        let many: Vec<String> = (0..20).map(|i| format!("f{i}.ts")).collect();
        assert_eq!(globs_from(Some(&json!(many))).lines().count(), 20);
    }

    #[test]
    fn the_sink_tools_are_advertised_with_usable_schemas() {
        for s in [sink_schema(), sink_read_schema(), drop_schema(), take_schema(), done_schema()] {
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

    /// **A convention an agent has to infer from a listing is one that gets
    /// inferred wrong**, which is how the sixth twin was made — a card read
    /// `sink`'s output, saw a wall-wide item, copied its title, and dropped
    /// without a scope. Marking the row is half the answer; the other half is
    /// `drop` saying what the mark means and what to pass. Asserted, because a
    /// tool description is prose and prose gets tidied.
    #[test]
    fn drop_says_what_seconding_a_wall_wide_item_takes() {
        let d = drop_schema()["description"].as_str().unwrap().to_string();
        assert!(d.contains("WALL"), "{d}");
        assert!(d.contains(r#"`scope: "skein"`"#), "{d}");
        assert!(d.contains("refused"), "{d}");
        /* And the listing says the same thing from the other side, so a card
           that reads only one of the two still hears it. */
        let r = sink_schema()["description"].as_str().unwrap().to_string();
        assert!(r.contains("WALL"), "{r}");
        assert!(r.contains("a title alone is not one"), "{r}");
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
        assert!(!render(&i, now, "c2", &scopes()).contains("reworded"));
        i.edited_at = Some(now - 60_000);
        assert!(render(&i, now, "c2", &scopes()).contains("the user reworded this 1m ago"));
    }

    /// Your own item needs no such note — it was your words to begin with, and
    /// saying so on every row you have ever tidied is noise in a reading an agent
    /// pays for.
    #[test]
    fn your_own_item_says_nothing_about_being_reworded() {
        let mut i = item(None, None);
        i.edited_at = Some(1_000);
        assert!(!render(&i, 60_000, "c2", &scopes()).contains("reworded"));
    }

    /* ── the index and the search (sink 5b039f69) ─────────────────────────── */

    fn titled(id: &str, title: &str, body: &str, paths: &str) -> SinkItem {
        let mut i = item(None, None);
        i.id = id.into();
        i.title = title.into();
        i.body = body.into();
        i.paths = paths.into();
        i
    }

    /// The whole point of the change: a listing row is one line and carries no
    /// body, so a pile of hundreds fits in a tool result.
    #[test]
    fn an_index_row_is_one_line_without_the_body() {
        let r = row(&item(None, None), 0, "c1", &scopes());
        assert_eq!(r.lines().count(), 1);
        assert!(r.contains("[abcd1234] WALL · bug — ask_user times out"));
        assert!(!r.contains("parks for ten minutes"));
    }

    #[test]
    fn the_index_names_the_tool_that_reads_in_full() {
        let a = item(None, None);
        let out = listing(&[&a], false, "", 0, "c1", &scopes());
        assert!(out.contains("`mcp__skein__sink_read`"));
        assert!(out.contains("Waiting, nobody on them"));
    }

    #[test]
    fn a_quoted_phrase_is_one_term_and_the_rest_split_on_space() {
        let t = terms_of(r#"Ask "time OUT"  park"#);
        let t: Vec<String> = t.iter().map(|c| c.iter().collect()).collect();
        assert_eq!(t, vec!["ask", "time out", "park"]);
        assert!(terms_of("   ").is_empty());
        assert!(terms_of(r#""""#).is_empty());
    }

    #[test]
    fn every_term_must_appear_and_a_title_hit_outranks_a_body_hit() {
        let in_title = titled("aaaa0001", "flow shader drifts", "nothing", "");
        let in_body = titled("aaaa0002", "something else", "the flow shader is off", "");
        let in_path = titled("aaaa0003", "x", "y", "src/flow/shader.ts");
        let t = terms_of("flow shader");
        assert!(score(&in_title, &t) > score(&in_path, &t));
        assert!(score(&in_path, &t) > score(&in_body, &t));
        assert_eq!(score(&in_body, &terms_of("flow walls")), None);
    }

    #[test]
    fn a_search_ranks_hits_and_shows_where_the_body_matched() {
        let a = titled("aaaa0001", "unrelated", "the walk camera snaps to the ground for a frame", "");
        let b = titled("bbbb0002", "walk camera snaps", "seen in walk mode", "");
        let c = titled("cccc0003", "nothing to see", "at all", "");
        let out = listing(&[&a, &b, &c], false, "walk camera", 0, "c1", &scopes());
        assert!(out.starts_with("2 match"));
        assert!(out.find("[bbbb0002]").unwrap() < out.find("[aaaa0001]").unwrap());
        assert!(out.contains("the walk camera snaps"));
        assert!(!out.contains("[cccc0003]"));
    }

    #[test]
    fn a_search_that_finds_nothing_says_how_to_widen_it() {
        let a = item(None, None);
        let out = listing(&[&a], false, "pixi", 0, "c1", &scopes());
        assert!(out.contains("matches \"pixi\""));
        assert!(out.contains("settled: true"));
    }

    /// A snippet is cut on chars, never bytes, and its ellipses say which ends
    /// were cut.
    #[test]
    fn a_snippet_is_a_window_around_the_first_match() {
        let body = format!("{} needle {}", "é".repeat(200), "z".repeat(200));
        let s = snippet(&body, &terms_of("NEEDLE")).unwrap();
        assert!(s.starts_with('…') && s.ends_with('…'));
        assert!(s.contains("needle"));
        assert!(s.chars().count() <= 162);
        assert_eq!(snippet("short body", &terms_of("short")).unwrap(), "short body");
        assert_eq!(snippet("short body", &terms_of("absent")), None);
    }

    /// Over budget, the index stops at a row and says how many it left out and
    /// how to see them, rather than overflowing the result it exists to fit in.
    #[test]
    fn an_index_over_budget_counts_what_it_left_out() {
        let long = "t".repeat(110);
        let pile: Vec<SinkItem> = (0..1_000)
            .map(|n| titled(&format!("{n:08}"), &long, "", ""))
            .collect();
        let refs: Vec<&SinkItem> = pile.iter().collect();
        let out = listing(&refs, false, "", 0, "c1", &scopes());
        assert!(out.len() < INDEX_BUDGET + 500);
        assert!(out.contains("more not listed"));
        assert!(out.contains("`query`"));
    }

    /// One bad address does not cost the others, and a settled item is read
    /// like an open one.
    #[test]
    fn reading_answers_each_address_on_its_own() {
        let a = titled("aaaa0001-x", "first", "body one", "");
        let mut b = titled("bbbb0002-x", "second", "body two", "");
        b.settled_at = Some(0);
        b.settled_note = Some("fixed in abc123".into());
        let out = read_out(&[a, b], &["aaaa0001", "nope", "bbbb0002", "aaaa0001"], 0, "c1", &scopes());
        assert!(out.contains("body one") && out.contains("body two"));
        assert!(out.contains("fixed in abc123"));
        assert!(out.contains("nothing answers to \"nope\""));
        assert_eq!(out.matches("body one").count(), 1, "a repeated id is read once");
    }

    /// A title with a comma in it arrives whole; a list of ids still splits.
    #[test]
    fn a_title_with_a_comma_is_one_address() {
        let t = json!("ask_user parks, then times out");
        assert_eq!(addresses(Some(&t)), vec!["ask_user parks, then times out"]);
        let ids = json!("5b039f69, 662b2900,c20a1cb2");
        assert_eq!(addresses(Some(&ids)), vec!["5b039f69", "662b2900", "c20a1cb2"]);
        let list = json!(["a, b", " 5b039f69 "]);
        assert_eq!(addresses(Some(&list)), vec!["a, b", "5b039f69"]);
    }

    /// An open item and a settled one under one title is a legitimate state,
    /// and a read prints both rather than refusing.
    #[test]
    fn a_shared_title_reads_every_item_under_it() {
        let a = titled("aaaa0001-x", "same title", "the open one", "");
        let mut b = titled("bbbb0002-x", "same title", "the settled one", "");
        b.settled_at = Some(0);
        let out = read_out(&[a, b], &["same title"], 0, "c1", &scopes());
        assert!(out.contains("the open one") && out.contains("the settled one"));
        assert!(out.contains("2 items answer to"));
        assert!(!out.contains("nothing was touched"));
    }

    /// A phrase matches across a line wrap, and the hit still has a snippet.
    #[test]
    fn a_phrase_matches_across_a_line_wrap() {
        let i = titled("aaaa0001", "x", "it parks and then times\n   out after five", "");
        let t = terms_of("\"times  out\"");
        assert!(score(&i, &t).is_some());
        assert!(snippet(&i.body, &t).unwrap().contains("times out"));
    }

    #[test]
    fn reading_past_its_budget_names_what_it_did_not_print() {
        let big = "b".repeat(3_900);
        let pile: Vec<SinkItem> = (0..30)
            .map(|n| titled(&format!("{n:08}"), "t", &big, ""))
            .collect();
        let want: Vec<String> = (0..30).map(|n| format!("{n:08}")).collect();
        let want: Vec<&str> = want.iter().map(String::as_str).collect();
        let out = read_out(&pile, &want, 0, "c1", &scopes());
        assert!(out.len() < READ_BUDGET + 2_000);
        assert!(out.contains("more not printed"));
        assert!(out.contains("00000029"));
    }
}
