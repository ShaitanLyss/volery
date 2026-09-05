//! Cards that can see each other — the roster, and messages between them.
//!
//! Two more tools on the server `ask.rs` already runs, for the same reason that
//! one is there: the URL carries the conversation id, so a call arrives already
//! addressed to a card and there is no correlation logic anywhere. `list`
//! answers who else is on the wall; `send` puts a message into another card's
//! stdin, where it becomes a turn.
//!
//! **Fire and forget, deliberately, where `ask_user` parks.** The parking
//! machinery is right next door and would be the wrong shape here: A waiting on
//! B while B waits on A is two cards wedged with no gesture that unsticks them,
//! and the ten-minute timeout would be the only thing that ever ended it. A
//! reply is the recipient calling `send` back. Symmetric, no deadlock, and
//! nothing to explain to the model.
//!
//! What the design is actually for is several agents working the same feature
//! at once — one has changed the schema, another is about to rebase onto it —
//! and the failure mode it has to survive is not a lost message but a spiral of
//! them. Everything under "the guards" below is that.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::store::{RosterRow, Store};

/// The tool names as the CLI sees them, prefixed by the server.
///
/// Named here because `classify.ts` needs the same two strings to draw the
/// calls, and a rename that reached one of the two would leave the other
/// drawing raw `mcp__skein__…` on the card.
pub const LIST_TOOL: &str = "list";
pub const SEND_TOOL: &str = "send";

/// How many `send` calls one card may make in a minute.
///
/// Counted per call and not per recipient, which is the whole reason a
/// broadcast is one call: fanning out to twelve cards deliberately is a thing
/// somebody asked for, and twelve separate sends in a second is a card in a
/// loop that has not noticed.
///
/// # Where `MAX_HOPS`' lesson lives now
///
/// There was a second guard beside this one — a cap on how far a single
/// exchange could travel, six hops — removed 2026-08-27 at the user's request.
/// `later.rs` and `spawn.rs` cite it *by name* for the half of it that was
/// always the durable part, so it is restated here, where a grep for
/// `MAX_HOPS` still lands: **a refusal must carry its reasoning and a way
/// forward, because an agent told only "no" will try a different phrasing of
/// the same message.** Every refusal in this file and in `spawn.rs` is written
/// to that rule, and it is the rule those comments are reaching for.
///
/// The cap itself went because it could not tell the two cases apart. Its own
/// comment claimed "six is a conversation and not a loop", and that was the
/// mistake: six substantive hands back and forth is roughly what negotiating
/// one shared file between two cards costs, and the exchange it actually
/// stopped was a hand-off of `hooks.rs` in the middle of being agreed. **Depth
/// was never the signal.** A loop is two agents saying the same thing to each
/// other; a long exchange is two agents converging. Nothing in a hop count
/// separates them, so the guard could only ever fire on both.
///
/// What still bounds the failure it was aimed at: this rate limit bounds a
/// burst, and `broadcast && hops > 0` below bounds fan-out — which was always
/// the N²/N³ half the hop cap explicitly did not touch. What is no longer
/// bounded is a *slow* two-card loop, a turn apiece, under this rate limit.
/// That is deliberate: stopping a real conversation was the more expensive of
/// the two failures, and it is the one that was actually happening.
///
/// `chain` and `hops` are still carried and still stored. They cost nothing,
/// the broadcast guard reads `hops`, and `relay.ts` draws a chain.
const MAX_SENDS: usize = 6;
const SEND_WINDOW: Duration = Duration::from_secs(60);

/// The most a message may carry.
///
/// A relay is a message, not a transfer: the recipient shares the machine and
/// can read the file. Truncated rather than refused, since a message that is
/// mostly right is worth delivering and an agent that had its send bounced will
/// send it again slightly shorter, twice.
///
/// Visible to the crate so `later.rs` can hold its own cap against it: a note a
/// card writes to itself costs nobody else a turn, so it has no business being
/// tighter than a message that does.
pub(crate) const MAX_BODY: usize = 4_000;

/// The first line of every delivered message, and the whole of how the front
/// end knows one when it sees it.
///
/// The recipient's CLI replays it as a plain `user` message, which is the same
/// shape as something you typed — so without a marker in the text itself a
/// message from another agent would be drawn in your register, in your card,
/// with nothing saying it was not you. Recognised off the words exactly the way
/// `rousing.ts::isResumePrompt` recognises a resume, and for the same reason:
/// both folds have to draw it, and the live one and the one that reads it back
/// off disk share nothing but the text.
pub const RELAY_MARK: &str = "[skein relay]";

/// What one card is currently acting inside, so a reply can be counted.
struct Inbound {
    chain: String,
    hops: i64,
    /// How many turn-closes this mark must outlive.
    ///
    /// One for the turn the message will be handled in, plus one more if a turn
    /// was already running when it was delivered — the CLI queues the prompt
    /// behind that turn, so its close is not the close of ours. Not perfect:
    /// two relays arriving during one turn, or a turn that never opens because
    /// the card was closed, leave the count off by one, and what a lost mark
    /// costs is one card getting to broadcast once. That is the right direction
    /// to be wrong in — the alternative is a mark that never clears, which
    /// silently forbids a card from ever broadcasting again.
    pending: u32,
}

#[derive(Default)]
pub struct Relays {
    inbound: Mutex<HashMap<String, Inbound>>,
    recent: Mutex<HashMap<String, Vec<Instant>>>,
}

/// A message on its way, for the wall to draw. One per recipient, so a
/// broadcast is a strand each rather than one event to be fanned out in the
/// webview.
#[derive(Clone, Serialize)]
struct RelaySent {
    id: String,
    from: String,
    to: String,
    /// False when the recipient was dormant and this went to its inbox. The
    /// strand still flies — something did leave — but nothing arrives.
    delivered: bool,
    /// Whether this was one of several from a single call, which is what lets
    /// the wall fan the strands apart instead of stacking them.
    broadcast: bool,
    /// This is a message that had been *waiting*, handed over as the card woke.
    /// The wall keeps an inbox mark per card and this is the only thing that
    /// takes one down — `delivered` cannot, since it is also true of every
    /// message that never waited at all.
    from_inbox: bool,
    /// What was said, clipped. Only for the wall's own use; the agent's copy
    /// went down the pipe.
    preview: String,
}

/* ── handles ──────────────────────────────────────────────────────────────
 *
 * A card's id is a uuid, and a model addressing one by 36 characters of hex is
 * tokens spent on nothing. The first eight are the handle: short enough to
 * repeat in prose, long enough that a wall would need millions of cards before
 * two collided. Titles work too, because they are what an agent will reach for
 * first — but they change under it (`naming.ts` renames as the work clarifies)
 * and two cards may share one, so an ambiguous title is refused *by name*
 * rather than guessed between.
 */

pub fn handle_of(id: &str) -> String {
    id.chars().take(8).collect()
}

/// Which row a written address means, or a sentence saying why none of them.
///
/// `pub(crate)` for `spawn::close`, which addresses a card the same way an agent
/// addresses one to `send` to it — by handle, or by the title it will reach for
/// first. What a written address *means* is one question and must have one
/// answer: a second implementation would eventually differ about an ambiguous
/// title, and the tool that guessed would be the one that closed a card.
pub(crate) fn resolve<'a>(rows: &'a [RosterRow], want: &str) -> Result<&'a RosterRow, String> {
    let want = want.trim();
    if want.is_empty() {
        return Err("no card was named".into());
    }
    if let Some(r) = rows.iter().find(|r| r.id == want) {
        return Ok(r);
    }
    if let Some(r) = rows.iter().find(|r| handle_of(&r.id) == want.to_lowercase()) {
        return Ok(r);
    }
    let by_title: Vec<&RosterRow> = rows
        .iter()
        .filter(|r| r.title.trim().eq_ignore_ascii_case(want))
        .collect();
    match by_title.len() {
        1 => Ok(by_title[0]),
        0 => Err(format!(
            "no card called {want:?} — call `mcp__skein__list` for the handles"
        )),
        _ => Err(format!(
            "{} cards are called {want:?}; name one by handle instead ({})",
            by_title.len(),
            by_title
                .iter()
                .map(|r| handle_of(&r.id))
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

/* ── the envelope ─────────────────────────────────────────────────────────── */

/// What the recipient's model actually reads.
///
/// Three jobs, and the middle one is the one that matters: say who this is
/// from, say plainly that it is *not the user*, and say that silence is a
/// legitimate reply. Without the second, a message arrives in the register of
/// an instruction from the person who owns the machine; without the third,
/// every message gets answered and the wall talks to itself.
///
/// The title is quoted, so a quote inside it would end the field the front end
/// reads the name out of. Folded to an apostrophe rather than escaped — one
/// less thing for two parsers in two languages to agree about.
pub fn envelope(from: &RosterRow, body: &str) -> String {
    let name = from.title.replace('"', "'");
    let body = clip(
        body,
        MAX_BODY,
        "Ask the card that sent this for the rest with `mcp__skein__send` — it still \
         holds what it wrote. Do not infer what was cut.",
    );
    format!(
        "{RELAY_MARK} from \"{name}\" ({}) in {} —\n\n{body}\n\n\
         (This came from another agent on the Skein wall, not from the user. \
         Act on it if it bears on your work, reply with the `mcp__skein__send` tool if \
         it needs an answer, and say nothing back if it does not.)",
        handle_of(&from.id),
        from.project,
    )
}

/// The envelope a *notice* arrives in when it comes to find you.
///
/// The same `RELAY_MARK` as a message, so the transcript folds it the same way
/// and there is one recogniser rather than two — but a third header line, since
/// this did not come from a card that decided to write to you. It came from the
/// billboard, and it says which file brought it.
///
/// `from` is absent when the notice is yours or when the card that posted it has
/// been closed since. The board's own name is used then, rather than an
/// invented sender: a notice outlives its author and saying otherwise would put
/// a closed card's words in a living one's mouth.
pub fn board_envelope(from: Option<&RosterRow>, notice: &crate::store::Notice, path: &str) -> String {
    let who = match from {
        Some(r) => format!(
            "\"{}\" ({})",
            r.title.replace('"', "'"),
            handle_of(&r.id)
        ),
        None => "the billboard".to_string(),
    };
    format!(
        "{RELAY_MARK} from the billboard — a notice from {who} covers `{path}`, which \
         you have just edited:\n\n\
         **{}**\n\n{}\n\n\
         (This is a standing notice on the Skein wall, not a message from the user, \
         and you are shown it once. Read it before going further with this file. Call \
         `mcp__skein__board` for the rest of what is up, and `mcp__skein__send` if you \
         need to agree something with whoever posted it.)",
        notice.subject.replace('"', "'"),
        clip(
            &notice.body,
            MAX_BODY,
            "Read the whole notice with `mcp__skein__board`.",
        ),
    )
}

/// Draw a notice reaching a card, when there is somewhere to draw it from.
///
/// The same strand a message gets: it is the same event on the wall — something
/// left one card and arrived at another. Silent when the poster is you or a
/// card that has closed, because a strand from nowhere is a strand that says the
/// wrong thing about where things are.
pub fn announce_board(app: &AppHandle, notice: &crate::store::Notice, to_id: &str) {
    let Some(from) = notice.from_id.as_deref() else { return };
    let live = app
        .state::<Store>()
        .0
        .lock()
        .ok()
        .and_then(|conn| crate::store::roster_one(&conn, from))
        .is_some();
    if !live {
        return;
    }
    let _ = app.emit(
        "relay:sent",
        RelaySent {
            id: crate::store::uuid_v4(),
            from: from.to_string(),
            to: to_id.to_string(),
            delivered: true,
            broadcast: false,
            from_inbox: false,
            preview: crate::clip::preview(&notice.subject, 240),
        },
    );
}

/// The relay's three budgets, all cut the same way.
///
/// This was the first marker on the wall — `[…truncated by skein at N
/// characters]` — and it was better than the four sites that said nothing. What
/// it left out is what a reader can *do*: a card told only that its message was
/// cut at 4,000 characters knows it is missing something and not how much, nor
/// who has the rest. Both are available here. The remedy differs per budget, so
/// it is passed in.
fn clip(s: &str, max: usize, remedy: &str) -> String {
    crate::clip::keep(s, max).marked(remedy)
}

/* ── the tools ────────────────────────────────────────────────────────────── */

pub fn list_schema() -> Value {
    json!({
        "name": LIST_TOOL,
        "description":
            "List the other Claude Code conversations open on this Skein wall, so you \
             can coordinate with them instead of duplicating their work or fighting \
             them over the same files. Each entry carries a `handle` — that is what \
             `send` takes. Worth calling before starting anything substantial in a \
             repository somebody else may be in, and again if you are about to change \
             something others build on.\n\n\
             A card opened by another card carries `spawned_by`, the handle of the one \
             that opened it; a card the user opened has no such field. Your own row is \
             marked `you`. Note that a parent in another territory is **not** in the \
             default scope — ask for `scope: \"skein\"` if a `spawned_by` handle is not \
             among the rows you can see.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "scope": {
                    "type": "string",
                    "enum": ["project", "skein"],
                    "description":
                        "`project` (the default) lists the cards working in your own \
                         project — nearly always who you mean. `skein` lists every \
                         card on the wall, across every project."
                }
            }
        }
    })
}

pub fn send_schema() -> Value {
    json!({
        "name": SEND_TOOL,
        "description":
            "Send a message to another conversation on this Skein wall. It arrives as \
             a turn in that card, marked as coming from you, and the agent there \
             decides what to do about it. Nothing is returned but a receipt: this does \
             not wait for a reply, and a reply is that agent calling `send` back.\n\n\
             Use it to coordinate real work — 'I have changed the store schema, rebase \
             before you touch store.rs', 'I own the transcript panel this afternoon', \
             'your migration and mine are both v14'. Do not use it to chat, to \
             acknowledge, or to say you have finished something nobody asked about: \
             every message costs the other agent a turn.\n\n\
             **If what you want is to find out who is working on what, read the \
             `board` first.** That is what the billboard is for, it costs nobody \
             anything, and it has usually already been answered up there — where a \
             message asking somebody what they are doing costs them a whole turn to \
             tell you something they had written down.\n\n\
             `to` takes a handle from `list`, a card's exact title, or a list of \
             either. It also takes the word `project` to reach every other card in \
             your project, or `skein` to reach every card on the wall — those two are \
             for announcements, and are refused when you are yourself acting on a \
             message somebody sent you.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "to": {
                    "description":
                        "Who to tell: a handle, a title, an array of them, or the word \
                         `project` or `skein` to broadcast.",
                    "anyOf": [
                        { "type": "string" },
                        { "type": "array", "items": { "type": "string" } }
                    ]
                },
                "message": {
                    "type": "string",
                    "description":
                        "What to tell them. Write it for another agent with its own \
                         context, not for the user: say what changed, where, and what \
                         you want them to do about it. Name files by path. Keep it to \
                         what they need — this is the whole of what they will get, and \
                         they cannot ask you a follow-up question."
                }
            },
            "required": ["to", "message"]
        }
    })
}

/// Answer `list`.
fn do_list(app: &AppHandle, caller: &str, args: &Value) -> String {
    let store = app.state::<Store>();
    let conn = match store.0.lock() {
        Ok(c) => c,
        Err(_) => return "the store is unavailable".into(),
    };

    let me = crate::store::roster_one(&conn, caller);
    /* Refused for the reason `do_send` is, one step earlier. A chat card can
       reach the open web and nothing on this machine, which is the whole of
       what the kind is for — and the roster is a list of this machine's
       directories. See `.claude/rules/chat.md`. */
    if me.as_ref().is_some_and(|m| m.kind == "chat") {
        return "this is a chat card: it stands outside the wall's projects and cannot \
                see the other conversations."
            .into();
    }
    let scope = args.get("scope").and_then(Value::as_str).unwrap_or("project");
    /* Unknown scopes fall back to the default rather than refusing. The model
       wrote a word; the worst reading of a wrong one is a shorter list. */
    let project = match (scope, &me) {
        ("skein", _) => None,
        (_, Some(m)) => Some(m.project_id.clone()),
        /* A caller with no row of its own cannot be narrowed to its project,
           and answering nothing would read as an empty wall. */
        (_, None) => None,
    };

    let rows = match crate::store::roster(&conn, project.as_deref()) {
        Ok(r) => r,
        Err(e) => return format!("could not read the roster: {e}"),
    };
    /* Who opened each of these, for every row rather than only the caller's own.
       Sink `0cf05791` is about a card that could not find its parent, and the
       system prompt is what actually closes that (`supervisor::Selfhood`) — but
       the roster is where an agent goes to *look*, and a row that carries every
       other fact about a card while staying silent about the one relationship
       the wall records reads as an answer. It was: the card checked `list`,
       found no parent field, and concluded from the absence that it was
       top-level.

       Read here rather than joined into `roster`, because the `spawned` table is
       deliberately never swept and the join would drop a parentage whose parent
       has been closed — see `store::provenance_row`, which makes the same
       distinction one layer down. Absent from the row when there is nothing to
       say, so `spawned_by` present means opened by a card and absent means
       opened by the user, with no third reading. */
    let parents: Vec<Option<String>> = rows
        .iter()
        .map(|r| crate::store::spawner_of(&conn, &r.id).map(|p| handle_of(&p)))
        .collect();
    drop(conn);

    let sup = app.state::<crate::supervisor::Supervisor>();
    let now = crate::store::now();
    let cards: Vec<Value> = rows
        .iter()
        .zip(parents)
        .map(|(r, spawned_by)| {
            let (open, in_turn) = sup.liveness(&r.id);
            let mut row = json!({
                "handle": handle_of(&r.id),
                "name": r.title,
                "you": r.id == caller,
                "project": r.project,
                "cwd": r.cwd,
                "worktree": r.worktree,
                "kind": r.kind,
                "state": if !open { "dormant" } else if in_turn { "working" } else { "idle" },
                "idle_seconds": r.last_turn_at.map(|t| (now - t).max(0) / 1000),
                "unread": r.inbox,
            });
            if let (Some(who), Some(obj)) = (spawned_by, row.as_object_mut()) {
                obj.insert("spawned_by".into(), Value::String(who));
            }
            row
        })
        .collect();

    json!({ "scope": if project.is_some() { "project" } else { "skein" }, "cards": cards })
        .to_string()
}

/// What `to` names, once the broadcast words are spent.
fn targets(rows: &[RosterRow], caller: &str, to: &Value) -> Result<(Vec<String>, bool), String> {
    let names: Vec<String> = match to {
        Value::String(s) => vec![s.clone()],
        Value::Array(a) => a
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect(),
        _ => return Err("`to` must be a handle, a title, or a list of them".into()),
    };
    if names.is_empty() {
        return Err("`to` named nobody".into());
    }

    let mut ids: Vec<String> = Vec::new();
    let mut broadcast = false;
    for name in &names {
        let word = name.trim().to_lowercase();
        if word == "project" || word == "skein" {
            broadcast = true;
            let mine = rows.iter().find(|r| r.id == caller).map(|r| r.project_id.clone());
            for r in rows {
                if r.id == caller {
                    continue;
                }
                /* A chat card can receive — it has no tools and nothing to be
                   turned against — but it is nobody's colleague either, and
                   sweeping it into an announcement about a repository it cannot
                   see is a turn spent on nothing. Address it by name if you
                   mean it. */
                if r.kind == "chat" {
                    continue;
                }
                if word == "project" && mine.as_deref() != Some(r.project_id.as_str()) {
                    continue;
                }
                ids.push(r.id.clone());
            }
        } else {
            ids.push(resolve(rows, name)?.id.clone());
        }
    }

    /* Named twice in one call — by handle and by title, say — is one message.
       Order-preserving rather than a sort, since the receipt reads back in the
       order they were asked for. */
    ids.retain(|id| id != caller);
    let mut seen = Vec::new();
    ids.retain(|id| {
        if seen.contains(id) {
            false
        } else {
            seen.push(id.clone());
            true
        }
    });
    Ok((ids, broadcast))
}

/// Answer `send`, and do it.
fn do_send(app: &AppHandle, caller: &str, args: &Value) -> String {
    let Some(body) = args.get("message").and_then(Value::as_str) else {
        return "no `message` was given, so nothing was sent".into();
    };
    if body.trim().is_empty() {
        return "the message was empty, so nothing was sent".into();
    }
    let Some(to) = args.get("to") else {
        return "no `to` was given, so nothing was sent".into();
    };

    let relays = app.state::<Relays>();
    let store = app.state::<Store>();

    let (rows, me) = {
        let Ok(conn) = store.0.lock() else {
            return "the store is unavailable".into();
        };
        let rows = match crate::store::roster(&conn, None) {
            Ok(r) => r,
            Err(e) => return format!("could not read the roster: {e}"),
        };
        let me = rows.iter().find(|r| r.id == caller).cloned();
        (rows, me)
    };
    let Some(me) = me else {
        return "this card is not on the wall, so it cannot send".into();
    };

    /* Decided by asking what kind of card this is, never by trusting the
       caller — the rule `spawn_conversation` follows for the same reason. A
       chat card spawns with no tool that touches this machine precisely so that
       what it reads on the web cannot act here; handing it a line into a card
       running --dangerously-skip-permissions would be that route, reopened. */
    if me.kind == "chat" {
        return "this is a chat card: it has no project and no tools that reach this \
                machine, and it may not message cards that do. Tell the user what you \
                wanted to pass on."
            .into();
    }

    /* The chain this send belongs to, and how far along it is. Read before
       anything is written, since delivering to a card sets *its* mark. */
    let (chain, hops) = match relays.inbound.lock().unwrap().get(caller) {
        Some(i) => (i.chain.clone(), i.hops + 1),
        None => (crate::store::uuid_v4(), 0),
    };
    /* No cap on how far this has travelled. There was one — six hops — and it
       stopped genuine coordination rather than a loop; see `MAX_SENDS`. `hops`
       is still counted, because the broadcast guard below is a different
       question and needs it. */

    if let Some(wait) = throttled(&relays, caller) {
        return format!(
            "this card has sent {MAX_SENDS} messages in the last minute, which is the \
             limit. Nothing was sent; try again in {wait}s if it still matters."
        );
    }

    let (ids, broadcast) = match targets(&rows, caller, to) {
        Ok(t) => t,
        Err(e) => return e,
    };
    if ids.is_empty() {
        return "there is nobody else on the wall to tell".into();
    }
    /* Broadcasting is something the user asked for; relaying is something you
       were told about. Fan-out is uncapped on purpose, so the one thing that
       must not happen is a broadcast whose recipients each broadcast — which
       is N² turns and then N³, and the hop limit does not touch it because the
       branching is the problem rather than the depth. */
    if broadcast && hops > 0 {
        return "broadcasting is only for something you started: you are acting on a \
                message another card sent you, so reply to that card instead."
            .into();
    }

    let text = envelope(&me, body);
    let mut receipts = Vec::new();
    for to_id in &ids {
        let awake = crate::supervisor::deliver(app, to_id, &text).is_ok();
        let relay_id = crate::store::uuid_v4();
        if let Ok(conn) = store.0.lock() {
            let _ = crate::store::record_relay(
                &conn, &relay_id, caller, to_id, body, &chain, hops, awake,
            );
        }
        if awake {
            arm(&relays, app, to_id, &chain, hops);
        }
        let name = rows
            .iter()
            .find(|r| &r.id == to_id)
            .map(|r| r.title.clone())
            .unwrap_or_else(|| handle_of(to_id));
        receipts.push(if awake {
            format!("delivered to \"{name}\" ({})", handle_of(to_id))
        } else {
            format!(
                "queued for \"{name}\" ({}) — that card is dormant and will be given \
                 this when it wakes",
                handle_of(to_id)
            )
        });
        let _ = app.emit(
            "relay:sent",
            RelaySent {
                id: relay_id,
                from: caller.to_string(),
                to: to_id.clone(),
                delivered: awake,
                broadcast,
                from_inbox: false,
                preview: crate::clip::preview(body, 240),
            },
        );
    }
    receipts.join("\n")
}

/// Whether this card has spent its minute, and how long is left of it.
fn throttled(relays: &Relays, caller: &str) -> Option<u64> {
    let now = Instant::now();
    let mut recent = relays.recent.lock().unwrap();
    let times = recent.entry(caller.to_string()).or_default();
    times.retain(|t| now.duration_since(*t) < SEND_WINDOW);
    if times.len() >= MAX_SENDS {
        let oldest = times[0];
        return Some((SEND_WINDOW - now.duration_since(oldest)).as_secs() + 1);
    }
    times.push(now);
    None
}

/// Mark a card as acting inside a chain, so what it sends next is counted.
fn arm(relays: &Relays, app: &AppHandle, to_id: &str, chain: &str, hops: i64) {
    let mid_turn = app
        .state::<crate::supervisor::Supervisor>()
        .liveness(to_id)
        .1;
    let mut inbound = relays.inbound.lock().unwrap();
    let entry = inbound.entry(to_id.to_string()).or_insert(Inbound {
        chain: chain.to_string(),
        hops,
        pending: 0,
    });
    entry.chain = chain.to_string();
    entry.hops = hops;
    /* See `Inbound::pending`: a message written while a turn is running is
       queued behind it by the CLI, so that turn's close is not ours. */
    entry.pending += if mid_turn { 2 } else { 1 };
}

/// A turn ended on this card. Called from `supervisor::persist_turn`, which is
/// the one place both boundaries of a turn already go through.
pub fn turn_closed(app: &AppHandle, id: &str) {
    let Some(relays) = app.try_state::<Relays>() else {
        return;
    };
    let mut inbound = relays.inbound.lock().unwrap();
    let done = match inbound.get_mut(id) {
        Some(i) => {
            i.pending = i.pending.saturating_sub(1);
            i.pending == 0
        }
        None => false,
    };
    if done {
        inbound.remove(id);
    }
}

/// Hand a woken card what was written to it while it slept.
///
/// Called from `spawn_conversation`, which is the one line both `wake` and
/// `open` reach — the same argument the `kind` lookup there makes. Ordered
/// oldest first and written before anything else, so a card woken by a prompt
/// you typed reads its post before your instruction, which is the order the two
/// actually happened in.
pub fn drain_inbox(app: &AppHandle, id: &str) {
    let Some(store) = app.try_state::<Store>() else {
        return;
    };
    let queued = {
        let Ok(conn) = store.0.lock() else { return };
        crate::store::inbox(&conn, id).unwrap_or_default()
    };
    if queued.is_empty() {
        return;
    }
    for q in queued {
        let from = {
            let Ok(conn) = store.0.lock() else { return };
            crate::store::roster_one(&conn, &q.from_id)
        };
        /* The sender has been closed since. The message still stands — it was
           true when it was written — so it is delivered under the handle it
           was sent from rather than dropped. */
        let text = match &from {
            Some(row) => envelope(row, &q.body),
            None => format!(
                "{RELAY_MARK} from a card that has since been closed ({}) —\n\n{}",
                handle_of(&q.from_id),
                q.body
            ),
        };
        if crate::supervisor::deliver(app, id, &text).is_ok() {
            if let Ok(conn) = store.0.lock() {
                crate::store::mark_delivered(&conn, &q.id);
            }
            if let Some(relays) = app.try_state::<Relays>() {
                arm(&relays, app, id, &q.chain, q.hops);
            }
            let _ = app.emit(
                "relay:sent",
                RelaySent {
                    id: q.id.clone(),
                    from: q.from_id.clone(),
                    to: id.to_string(),
                    delivered: true,
                    broadcast: false,
                    from_inbox: true,
                    preview: crate::clip::preview(&q.body, 240),
                },
            );
        }
    }
}

/// Route a `tools/call` that is not a question.
///
/// `ask.rs` owns the transport and knows nothing about what a roster is; this
/// is where a tool name becomes an answer. Returns `None` for a name neither
/// file claims, so the caller can say so rather than parking on it.
pub fn handle(app: &AppHandle, conversation_id: &str, tool: &str, args: &Value) -> Option<String> {
    match tool {
        LIST_TOOL => Some(do_list(app, conversation_id, args)),
        SEND_TOOL => Some(do_send(app, conversation_id, args)),
        TOUCHED_TOOL => Some(do_touched(app, conversation_id, args)),
        RECALL_TOOL => Some(do_recall(app, conversation_id, args)),
        _ => None,
    }
}

/* ── seeing rather than speaking ──────────────────────────────────────────
 *
 * `list` and `send` are what this file was for: who is here, and a message into
 * one of their hands. These two are the other half, and the reason they belong
 * beside them is the sentence every description on this server keeps repeating —
 * **reading costs nobody a turn, and a `send` costs that agent one.**
 *
 * The billboard already makes that argument for standing notices and it only
 * goes half the distance, because a notice is something a card *remembered to
 * write*. Two questions come up constantly that no notice answers and that a
 * card currently has no way to ask except by taking somebody's turn:
 *
 * - "am I about to work in a file another conversation is in?" — which the wall
 *   has recorded all along in `file_touch`, from the first build, read by almost
 *   nobody (see the note at the top of `store.rs`).
 * - "what did the card that did the schema migration actually conclude?" — which
 *   is sitting in that card's transcript on disk.
 *
 * Both are reads. Neither can be answered by the agent on its own: one is the
 * wall's ledger and the other is another process's memory. That is exactly the
 * test a tool on this server has to pass.
 */

pub const TOUCHED_TOOL: &str = "touched";
pub const RECALL_TOOL: &str = "recall";

/// How many paths one call may ask about. Eight is more files than a single
/// piece of work is ever in, and few enough that the answer stays a page.
const MAX_ASKED: usize = 8;

/// How many recorded visits to consider per path. The reading wants the latest
/// visit per card, not a history, so this only has to be deep enough that a busy
/// file's recent past is not all one card.
const TOUCH_DEPTH: i64 = 200;

/// How far back a visit is worth mentioning.
///
/// A week. Beyond that it is not "somebody is in this file", it is "somebody
/// worked on this project", which is what `git log` is for and is not news. The
/// cut matters more than it looks: without it every file in a mature repository
/// comes back with a paragraph of ancient history attached, and an agent that
/// learns this tool answers noise stops reading the answer.
const TOUCH_WINDOW_MS: i64 = 7 * 24 * 60 * 60 * 1_000;

/// How many of a card's last turns `recall` hands back.
const RECALL_TURNS: usize = 6;
const MAX_RECALL_CHARS: usize = 3_000;

pub fn touched_schema() -> Value {
    json!({
        "name": TOUCHED_TOOL,
        "description":
            "Who else on this wall has been in these files, and whether they wrote or \
             only read. Skein has recorded every file every conversation has touched \
             since it started, so this is evidence rather than a notice somebody \
             remembered to post — it answers for the agent that changed a file and said \
             nothing about it.\n\n\
             **Ask before you start editing shared code**, especially in a repository \
             where `list` shows other conversations. It costs nobody a turn, where \
             asking them directly costs each of them one. Read the `board` too: that is \
             what somebody *intends*, this is what has actually happened.\n\n\
             A write by a conversation that is still on the wall is the one answer worth \
             stopping for — say so to the user, and consider `send`ing that card rather \
             than working over it. A write by a card that has since closed is history, \
             and a read by anybody is not a clash at all.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "paths": {
                    "description":
                        "The files you are about to work in. Write them as you would \
                         type them — 'src/lib/sink.ts', 'store.rs' — the tail of a path \
                         is matched, so the absolute form is not needed. Omit this \
                         entirely to ask about every file *this* conversation has \
                         already touched, which is the shape of \"is anybody in my way\".",
                    "anyOf": [
                        { "type": "string" },
                        { "type": "array", "items": { "type": "string" } }
                    ]
                }
            }
        }
    })
}

pub fn recall_schema() -> Value {
    json!({
        "name": RECALL_TOOL,
        "description":
            "Read what another conversation on this wall has been saying — the last few \
             things it told its user, off its own transcript.\n\n\
             **This is what to do instead of messaging a card to ask what it did.** A \
             `send` costs that agent a whole turn and interrupts whatever it is in the \
             middle of; this costs nobody anything and usually contains the answer, \
             because a conversation that has just finished a piece of work has said so. \
             Use `send` when you need something *from* them — a decision, a rebase, a \
             hand-off. Use this when you need to know what happened.\n\n\
             Call `list` first for the handles. What comes back is that card's words, \
             not a summary: treat it as evidence about what it believes it has done, \
             which is not the same as what is in the repository.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "card": {
                    "type": "string",
                    "description":
                        "Which conversation, by the handle `list` gave, or by its exact \
                         title."
                }
            },
            "required": ["card"]
        }
    })
}

/* ── touched ──────────────────────────────────────────────────────────────── */

/// The latest thing one card did to one file.
struct Visit {
    card: String,
    path: String,
    wrote: bool,
    at: i64,
}

fn do_touched(app: &AppHandle, caller: &str, args: &Value) -> String {
    let Some(store) = app.try_state::<Store>() else {
        return "the store is unavailable".into();
    };
    let now = crate::store::now();

    let asked: Vec<String> = match args.get("paths") {
        Some(v) => globs_from(v),
        /* No paths given: ask about what this card has been in. `store::touches_near`
           wants a needle, and the needle for "my own files" is each of their
           basenames — so the caller's own recorded visits are read first and
           turned into the question. */
        None => {
            let Ok(conn) = store.0.lock() else {
                return "the store is unavailable".into();
            };
            let mine = crate::store::touches_near(&conn, "", TOUCH_DEPTH * 2);
            drop(conn);
            let mut names: Vec<String> = Vec::new();
            for t in mine.into_iter().filter(|t| t.conversation_id == caller) {
                let base = t.path.replace('\\', "/");
                let base = base.rsplit('/').next().unwrap_or(&base).to_string();
                if !base.is_empty() && !names.contains(&base) {
                    names.push(base);
                }
                if names.len() >= MAX_ASKED {
                    break;
                }
            }
            if names.is_empty() {
                return "this conversation has not touched any file yet, so there is \
                        nothing to compare. Name the paths you are about to work in."
                    .into();
            }
            names
        }
    };
    if asked.is_empty() {
        return "no paths were named".into();
    }

    /* Who is still here, so a write can be told from a wound that has healed. */
    let (live, titles) = {
        let Ok(conn) = store.0.lock() else {
            return "the store is unavailable".into();
        };
        let rows = crate::store::roster(&conn, None).unwrap_or_default();
        let live: Vec<String> = rows.iter().map(|r| r.id.clone()).collect();
        let titles: Vec<(String, String)> =
            rows.iter().map(|r| (r.id.clone(), r.title.clone())).collect();
        (live, titles)
    };
    let name_of = |id: &str| -> String {
        titles
            .iter()
            .find(|(rid, _)| rid == id)
            .map(|(_, t)| {
                let t = t.trim();
                if t.is_empty() { handle_of(id) } else { format!("{t} ({})", handle_of(id)) }
            })
            .unwrap_or_else(|| format!("{} — closed since", handle_of(id)))
    };

    let mut out = String::new();
    let mut anything = false;

    for want in asked.iter().take(MAX_ASKED) {
        let base = {
            let w = want.replace('\\', "/");
            w.rsplit('/').next().unwrap_or(&w).to_string()
        };
        let rows = {
            let Ok(conn) = store.0.lock() else { continue };
            crate::store::touches_near(&conn, &base, TOUCH_DEPTH)
        };

        /* One entry per (card, path), keeping the most recent — and a write
           outranks a read at the same moment, because "somebody changed this" is
           the fact being reported and a card that read the file before writing it
           has done both. */
        let mut latest: Vec<Visit> = Vec::new();
        for t in rows {
            if t.conversation_id == caller || now - t.at > TOUCH_WINDOW_MS {
                continue;
            }
            /* `board::covers` rather than trusting the substring: the narrowing
               was SQL's, the decision is the one already written for notices. */
            if !crate::board::covers(want, &t.path) {
                continue;
            }
            let wrote = t.op == "write";
            match latest
                .iter_mut()
                .find(|v| v.card == t.conversation_id && v.path == t.path)
            {
                Some(v) => {
                    if wrote && !v.wrote {
                        v.wrote = true;
                        v.at = v.at.max(t.at);
                    }
                }
                None => latest.push(Visit {
                    card: t.conversation_id.clone(),
                    path: t.path.clone(),
                    wrote,
                    at: t.at,
                }),
            }
        }
        if latest.is_empty() {
            out.push_str(&format!("- {want}: nobody else has been in it.\n"));
            continue;
        }
        anything = true;
        /* Writes first, then most recent — the order the answer is acted on. */
        latest.sort_by(|a, b| b.wrote.cmp(&a.wrote).then(b.at.cmp(&a.at)));
        out.push_str(&format!("- {want}:\n"));
        for v in latest.iter().take(6) {
            let still = if live.iter().any(|id| id == &v.card) {
                ", still on the wall"
            } else {
                ""
            };
            out.push_str(&format!(
                "    {} {} it {}{still}\n",
                name_of(&v.card),
                if v.wrote { "WROTE" } else { "read" },
                ago(now - v.at),
            ));
        }
    }

    if !anything {
        return format!(
            "{out}\nNothing to work around — no other conversation has been in any of \
             these in the last week."
        );
    }
    format!(
        "{out}\nA WROTE by a card that is still on the wall is the one to stop for: tell \
         the user, and `mcp__skein__send` that card rather than editing over it. A closed \
         card's write is history, and a read is not a clash. `mcp__skein__board` says what \
         anybody *intends*; this is only what has happened."
    )
}

/* ── recall ───────────────────────────────────────────────────────────────── */

fn do_recall(app: &AppHandle, caller: &str, args: &Value) -> String {
    let Some(want) = args.get("card").and_then(Value::as_str) else {
        return "name the card by its handle or its exact title — call `mcp__skein__list` \
                for them"
            .into();
    };
    let Some(store) = app.try_state::<Store>() else {
        return "the store is unavailable".into();
    };
    let rows = {
        let Ok(conn) = store.0.lock() else {
            return "the store is unavailable".into();
        };
        crate::store::roster(&conn, None).unwrap_or_default()
    };
    let row = match resolve(&rows, want) {
        Ok(r) => r,
        Err(why) => return why,
    };
    if row.id == caller {
        return "that is this conversation — you already have its transcript.".into();
    }

    let (cwd, session) = {
        let Ok(conn) = store.0.lock() else {
            return "the store is unavailable".into();
        };
        crate::store::session_of(&conn, &row.id).unwrap_or((row.cwd.clone(), None))
    };
    let Some(session) = session else {
        return format!(
            "{} has not taken a turn yet, so it has said nothing to read.",
            handle_of(&row.id)
        );
    };
    let path = match crate::supervisor::transcript_path(app, &cwd, &session) {
        Ok(p) => p,
        Err(e) => return format!("could not work out where that card's transcript is: {e}"),
    };
    let said = match tail_of_transcript(&path, RECALL_TURNS) {
        Ok(s) => s,
        /* Named rather than smoothed over: "it has said nothing" and "the file is
           not there" are answered completely differently, and an agent told the
           first would report to the user that a card had been idle when in fact
           Skein could not find its transcript. */
        Err(e) => return format!("could not read that card's transcript: {e}"),
    };
    if said.is_empty() {
        return format!(
            "{} has a transcript but nothing in it that reads as speech yet.",
            handle_of(&row.id)
        );
    }

    let who = {
        let t = row.title.trim();
        if t.is_empty() { handle_of(&row.id) } else { t.to_string() }
    };
    format!(
        "The last {} thing{} {who} ({}) said, oldest first:\n\n{}\n\nThat is its own \
         account of what it has been doing, not a check on whether it did it. If you need \
         something *from* it, `mcp__skein__send`.",
        said.len(),
        if said.len() == 1 { "" } else { "s" },
        handle_of(&row.id),
        said.join("\n\n---\n\n")
    )
}

/// Where the search for a card's last words starts, in bytes back from EOF.
///
/// The same 256 KB `sessions.rs` measured its tail at, and taken from there
/// rather than picked: that measurement says the last answered `assistant`
/// record sat 82.3 KB from EOF at worst across 278 transcripts on this machine
/// (p50 2.4 KB). This wants *several* of them rather than one, so the window
/// grows if the first pass comes up short — see below.
const TAIL_FROM: u64 = 256 * 1024;

/// How far back it will go before giving up and answering with what it found.
///
/// Eight megabytes. A card whose last six speeches are further back than that
/// has spent millions of characters of tool output saying nothing, and reading
/// the whole file to prove it is not worth what it costs on a tool an agent may
/// reach for on any turn.
const TAIL_MAX: u64 = 8 * 1024 * 1024;

/// The last `n` things an agent said, out of a transcript on disk.
///
/// **Read from the end, in a window that doubles, rather than streamed whole.**
/// The first cut of this read every line of the file, which is fine for the
/// median transcript (28 KB) and is not fine for the one that matters: a card
/// that has been working all day is both the one worth recalling and the one
/// whose `.jsonl` runs to tens of megabytes. `sessions.rs` learned the same
/// lesson one file over and its `feed_range` is where the partial-line handling
/// is argued — a line cut in half at the window's edge still carries
/// `"type":"assistant"`, fails to parse, and would silently cost a speech.
///
/// Doubling rather than a single generous window, because the distance from EOF
/// to the sixth-from-last speech is not a property this can measure: a card that
/// read three large files between two sentences puts megabytes of tool result
/// where `sessions.rs` only ever had to skip its own bookkeeping. So the window
/// grows until it has `n`, or reaches the start of the file, or hits `TAIL_MAX`
/// — and the last of those answers with what it found rather than failing, since
/// four speeches is a useful answer and an error is not.
fn tail_of_transcript(path: &std::path::Path, n: usize) -> Result<Vec<String>, String> {
    let size = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
    let mut window = TAIL_FROM;
    loop {
        let from = size.saturating_sub(window);
        let found = speeches_from(path, n, from)?;
        /* Enough, or there is no more file to look at, or far enough. */
        if found.len() >= n || from == 0 || window >= TAIL_MAX {
            return Ok(found);
        }
        window *= 2;
    }
}

/// The last `n` speeches in `[from, EOF)`, oldest first.
///
/// A read that does not start at byte 0 drops its first line, per
/// `sessions::feed_range`: half a line can still carry `"type":"assistant"`, and
/// what it costs here is not a wrong field but a speech quietly missing from an
/// answer that looks complete.
fn speeches_from(
    path: &std::path::Path,
    n: usize,
    from: u64,
) -> Result<Vec<String>, String> {
    use std::io::{BufRead, Seek};
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    if from > 0 {
        file.seek(std::io::SeekFrom::Start(from))
            .map_err(|e| e.to_string())?;
    }
    let mut ring: std::collections::VecDeque<String> = std::collections::VecDeque::new();
    let mut first = true;
    for line in std::io::BufReader::new(file).lines() {
        let Ok(line) = line else { continue };
        let partial = first && from > 0;
        first = false;
        if partial || line.is_empty() {
            continue;
        }
        /* A cheap reject before parsing. Most lines in a transcript are not
           assistant messages and `serde_json` on each of them is the whole cost
           of this function. */
        if !line.contains("\"assistant\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        let blocks = v
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(Value::as_array);
        let Some(blocks) = blocks else { continue };
        let text: String = blocks
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n");
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        /* What a card said, for `recall`. The remedy names `send` because the
           card is still on the wall and still has its own words — this cost the
           tail of a card's only report on 2026-09-03 and there was no way to
           ask for the rest. */
        ring.push_back(clip(
            text,
            MAX_RECALL_CHARS,
            "This is the card's own account, cut to fit. If the tail matters, \
             `mcp__skein__send` and ask it — do not report a conclusion drawn from a \
             clipped report.",
        ));
        while ring.len() > n {
            ring.pop_front();
        }
    }
    Ok(ring.into_iter().collect())
}

/// Whatever the model wrote, as a list of paths. Same shape as
/// `board::globs_from`, and not shared with it for the reason stated there.
fn globs_from(v: &Value) -> Vec<String> {
    match v {
        Value::String(s) => s
            .split(['\n', ','])
            .map(|g| g.trim().to_string())
            .filter(|g| !g.is_empty())
            .collect(),
        Value::Array(a) => a
            .iter()
            .filter_map(|x| x.as_str())
            .map(|g| g.trim().to_string())
            .filter(|g| !g.is_empty())
            .collect(),
        _ => Vec::new(),
    }
}

/// How long ago, in the words a tool answer uses.
///
/// `pub(crate)` for `servers.rs`, which owes the same sentence about when a dev
/// server last printed anything. A second copy would be a second vocabulary —
/// two tools on one MCP server saying "4m ago" and "4 minutes ago" about the
/// same span reads as two tools written by two people, which is the argument
/// `servers::quiet` already makes about `SKEIN_NO_SERVERS` and `SKEIN_NO_WAKE`.
pub(crate) fn ago(ms: i64) -> String {
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

/* ── the control surface's way in ─────────────────────────────────────────
 *
 * Driving the tools by hand, so `wall.test.ts` can exercise a send without an
 * agent taking a turn to make one — the same seam `rouse` and `broadcast` are
 * driven through, and the ops call the shipped path rather than a copy of it.
 *
 * **`relay_send` goes through `off_main`, and the reason is the pipe.** A
 * `#[tauri::command]` without `async` runs inline on the thread that drains the
 * event-loop queue, so anything that parks there stops every card on the wall
 * from being painted for as long as it parks (see the rule in CLAUDE.md). A
 * write to a child's stdin is microseconds until the child stops reading it, at
 * which point the pipe fills and the write blocks — and a broadcast is one of
 * those per card on the wall, each made while `deliver` holds the supervisor's
 * map. `send_prompt` has always had the narrow version of this hazard; what is
 * new is that an agent can now reach it N times in one call.
 *
 * `relay_roster` follows it off the main thread for uniformity rather than out
 * of need — it is two queries — and the honest note is that if it ever stops
 * being two queries, this is already the right place for it.
 *
 * The tools themselves need none of this: they are answered on the ask server's
 * own per-request thread, which is where the parking `ask_user` does already
 * happens.
 */

#[tauri::command]
pub async fn relay_roster(
    app: AppHandle,
    id: String,
    scope: Option<String>,
) -> Result<Value, String> {
    let out = crate::off_main(move || {
        let args = json!({ "scope": scope.unwrap_or_else(|| "project".into()) });
        do_list(&app, &id, &args)
    })
    .await?;
    serde_json::from_str(&out).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn relay_send(
    app: AppHandle,
    id: String,
    to: Value,
    message: String,
) -> Result<String, String> {
    crate::off_main(move || do_send(&app, &id, &json!({ "to": to, "message": message }))).await
}

/// Every card's undelivered count, for the wall's inbox marks on restore.
#[tauri::command]
pub fn relay_inboxes(store: State<'_, Store>) -> Result<Value, String> {
    let conn = store.0.lock().map_err(|_| "the store is unavailable")?;
    let counts: HashMap<String, i64> = crate::store::inbox_counts(&conn).into_iter().collect();
    serde_json::to_value(counts).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /* ── seeing rather than speaking ──────────────────────────────────────── */

    /// The whole argument for these two living here rather than being a `send`:
    /// both descriptions have to say that reading is free and a message is not,
    /// or an agent with a roster in front of it will message somebody to ask.
    #[test]
    fn both_readings_say_they_are_cheaper_than_asking() {
        let t = touched_schema()["description"].as_str().unwrap().to_string();
        assert!(t.contains("costs nobody a turn"), "{t}");
        assert!(t.contains("board"), "the board answers the other half — {t}");

        let r = recall_schema()["description"].as_str().unwrap().to_string();
        assert!(r.contains("instead of messaging"), "{r}");
        assert!(r.contains("costs that agent a whole turn"), "{r}");
        /* And when a `send` *is* right, or the tool would teach an agent never
           to message anybody. */
        assert!(r.contains("Use `send` when"), "{r}");
    }

    /// `touched` reports a fact and the fact is worthless without the reading of
    /// it: a live card's write is a collision, a closed card's is history, and a
    /// read is neither.
    #[test]
    fn touched_says_which_answer_is_worth_stopping_for() {
        let t = touched_schema()["description"].as_str().unwrap().to_string();
        assert!(t.contains("still on the wall"));
        assert!(t.contains("history"));
        assert!(t.contains("not a clash"));
    }

    #[test]
    fn paths_arrive_in_both_spellings() {
        assert_eq!(
            globs_from(&json!("src/lib/sink.ts, store.rs")),
            vec!["src/lib/sink.ts", "store.rs"]
        );
        assert_eq!(globs_from(&json!(["a.ts", "  b.ts  "])), vec!["a.ts", "b.ts"]);
        assert!(globs_from(&json!(null)).is_empty());
    }

    /// Only what the agent *said*, oldest first, and only the last few.
    ///
    /// Thinking is not something a card said and a tool call is machinery — what
    /// `recall` is for is the account a conversation gave its user, which is the
    /// one thing in a transcript that answers "what did it conclude".
    #[test]
    fn the_tail_of_a_transcript_is_speech_and_nothing_else() {
        let dir = std::env::temp_dir().join(format!("skein-recall-{}", crate::store::uuid_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session.jsonl");
        let lines = [
            r#"{"type":"user","message":{"content":"do the thing"}}"#.to_string(),
            /* Two blocks in one message, one of them thinking — the shape
               `usage.rs` had to learn about, here for a different reason. */
            r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":"first"}]}}"#.to_string(),
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{}}]}}"#.to_string(),
            String::new(),
            "not json at all".to_string(),
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"second"}]}}"#.to_string(),
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"third"}]}}"#.to_string(),
        ];
        std::fs::write(&path, lines.join("\n")).unwrap();

        let all = tail_of_transcript(&path, 6).unwrap();
        assert_eq!(all, vec!["first", "second", "third"]);

        /* The ring keeps the *last* n, since what a card most recently said is
           what answers the question. */
        let two = tail_of_transcript(&path, 2).unwrap();
        assert_eq!(two, vec!["second", "third"]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A transcript that is not there is named, never reported as silence: "it
    /// has said nothing" and "Skein could not find its file" are answered
    /// completely differently by whoever reads the reply.
    #[test]
    fn a_missing_transcript_is_an_error_rather_than_an_empty_reading() {
        let path = std::env::temp_dir().join("skein-no-such-transcript.jsonl");
        assert!(tail_of_transcript(&path, 4).is_err());
    }

    /// Reading from the end must answer what reading the whole file answers.
    ///
    /// The window starts at 256 KB, so this writes past it deliberately — a
    /// megabyte of tool-result padding between the speeches, which is the shape
    /// of the card most worth recalling and the one the first cut of this
    /// function read entirely. A window that starts mid-line still carries
    /// `"type":"assistant"`, and the cost of not dropping that line is not a
    /// wrong field but a speech missing from an answer that looks complete.
    #[test]
    fn the_tail_is_read_from_the_end_and_answers_the_same() {
        let dir = std::env::temp_dir().join(format!("skein-tail-{}", crate::store::uuid_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("long.jsonl");

        let say = |t: &str| {
            format!(r#"{{"type":"assistant","message":{{"content":[{{"type":"text","text":"{t}"}}]}}}}"#)
        };
        /* Big enough that no speech is within TAIL_FROM of the next, so the
           window has to grow to find six of them. */
        let padding = format!(
            r#"{{"type":"user","message":{{"content":"{}"}}}}"#,
            "x".repeat(200_000)
        );
        let mut lines = Vec::new();
        for i in 0..8 {
            lines.push(say(&format!("speech {i}")));
            lines.push(padding.clone());
        }
        std::fs::write(&path, lines.join("\n")).unwrap();
        assert!(
            std::fs::metadata(&path).unwrap().len() > TAIL_FROM * 4,
            "the fixture has to outgrow the first window or this proves nothing"
        );

        let six = tail_of_transcript(&path, 6).unwrap();
        assert_eq!(six.len(), 6);
        assert_eq!(six.first().unwrap(), "speech 2");
        assert_eq!(six.last().unwrap(), "speech 7");

        /* And asking for more than the file holds walks to the start and stops
           there rather than looping. */
        let all = tail_of_transcript(&path, 40).unwrap();
        assert_eq!(all.len(), 8);
        assert_eq!(all.first().unwrap(), "speech 0");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ages_are_said_at_every_scale() {
        assert_eq!(ago(0), "just now");
        assert_eq!(ago(5 * 60_000), "5m ago");
        assert_eq!(ago(3 * 3_600_000), "3h ago");
        assert_eq!(ago(4 * 86_400_000), "4d ago");
    }

    /// A week, and the cut is what keeps the tool worth reading: without it every
    /// file in a mature repository comes back with a paragraph of ancient
    /// history, and an agent that learns this answers noise stops reading it.
    #[test]
    fn the_touch_window_is_a_week() {
        assert_eq!(TOUCH_WINDOW_MS, 7 * 24 * 60 * 60 * 1_000);
    }

    fn row(id: &str, title: &str, project: &str, kind: &str) -> RosterRow {
        RosterRow {
            id: id.into(),
            title: title.into(),
            project: project.into(),
            project_id: project.into(),
            cwd: format!("C:/{project}"),
            worktree: None,
            kind: kind.into(),
            last_turn_at: None,
            inbox: 0,
        }
    }

    fn wall() -> Vec<RosterRow> {
        vec![
            row("aaaaaaaa-1111-4111-8111-111111111111", "store schema", "skein", "project"),
            row("bbbbbbbb-2222-4222-8222-222222222222", "transcript", "skein", "project"),
            row("cccccccc-3333-4333-8333-333333333333", "asset dxf", "assets", "project"),
            row("dddddddd-4444-4444-8444-444444444444", "reading", "chat", "chat"),
        ]
    }

    #[test]
    fn a_handle_is_the_head_of_the_id() {
        assert_eq!(handle_of("aaaaaaaa-1111-4111-8111-111111111111"), "aaaaaaaa");
    }

    #[test]
    fn a_card_answers_to_its_handle_its_id_and_its_title() {
        let w = wall();
        let want = &w[0].id;
        assert_eq!(&resolve(&w, "aaaaaaaa").unwrap().id, want);
        assert_eq!(&resolve(&w, want).unwrap().id, want);
        assert_eq!(&resolve(&w, "store schema").unwrap().id, want);
        // A title is what an agent reaches for first, so it is matched loosely.
        assert_eq!(&resolve(&w, "  Store Schema ").unwrap().id, want);
    }

    /// Guessing between two cards with the same name would put a message in the
    /// wrong repository, silently. Titles are generated and collide often.
    #[test]
    fn an_ambiguous_title_is_refused_by_name() {
        let mut w = wall();
        w[1].title = "store schema".into();
        let e = resolve(&w, "store schema").unwrap_err();
        assert!(e.contains("aaaaaaaa") && e.contains("bbbbbbbb"), "{e}");
    }

    #[test]
    fn an_unknown_address_says_how_to_find_a_real_one() {
        let e = resolve(&wall(), "nobody").unwrap_err();
        assert!(e.contains("list"), "{e}");
    }

    #[test]
    fn project_reaches_the_rest_of_your_project_and_nothing_else() {
        let w = wall();
        let (ids, broadcast) = targets(&w, &w[0].id, &json!("project")).unwrap();
        assert!(broadcast);
        assert_eq!(ids, vec![w[1].id.clone()]);
    }

    #[test]
    fn skein_reaches_every_project() {
        let w = wall();
        let (ids, _) = targets(&w, &w[0].id, &json!("skein")).unwrap();
        assert_eq!(ids, vec![w[1].id.clone(), w[2].id.clone()]);
    }

    /// A chat card has no repository to be coordinated about, so an
    /// announcement to the wall is a turn it spends on nothing. Addressed by
    /// name it still receives — that is a question somebody meant to ask.
    #[test]
    fn a_broadcast_passes_over_chat_cards_and_a_named_send_does_not() {
        let w = wall();
        let (ids, _) = targets(&w, &w[0].id, &json!("skein")).unwrap();
        assert!(!ids.contains(&w[3].id));
        let (named, _) = targets(&w, &w[0].id, &json!("reading")).unwrap();
        assert_eq!(named, vec![w[3].id.clone()]);
    }

    #[test]
    fn several_recipients_are_one_call_and_are_not_repeated() {
        let w = wall();
        let (ids, broadcast) =
            targets(&w, &w[0].id, &json!(["transcript", "bbbbbbbb", "asset dxf"])).unwrap();
        assert!(!broadcast);
        assert_eq!(ids, vec![w[1].id.clone(), w[2].id.clone()]);
    }

    /// Talking to yourself is a send that should have been a thought, and in a
    /// broadcast it would be a card handing itself a turn forever.
    #[test]
    fn a_card_is_never_a_recipient_of_its_own_message() {
        let w = wall();
        assert!(targets(&w, &w[0].id, &json!("store schema")).unwrap().0.is_empty());
        let (ids, _) = targets(&w, &w[0].id, &json!("skein")).unwrap();
        assert!(!ids.contains(&w[0].id));
    }

    #[test]
    fn the_envelope_names_the_sender_and_says_it_is_not_the_user() {
        let e = envelope(&wall()[0], "rebase before you touch store.rs");
        assert!(e.starts_with(RELAY_MARK));
        assert!(e.contains("\"store schema\""));
        assert!(e.contains("(aaaaaaaa)"));
        assert!(e.contains("rebase before you touch store.rs"));
        assert!(e.contains("not from the user"));
    }

    /// The front end reads the name out of a quoted field, so a quote in a
    /// title would end it early and the cap would name half a card.
    #[test]
    fn a_quote_in_a_title_cannot_break_the_envelope() {
        let mut r = wall()[0].clone();
        r.title = "the \"good\" one".into();
        let e = envelope(&r, "hello");
        assert!(e.contains("\"the 'good' one\""), "{e}");
        assert_eq!(e.matches('"').count(), 2);
    }

    /// A message too long to carry is cut, not refused — and the cut says how
    /// much went and who still has it.
    ///
    /// The marker used to read `[…truncated by skein at N characters]`, which
    /// named the budget and neither the loss nor a next move. `crate::clip`
    /// supplies all three; this asserts the two that a reader can act on. A run
    /// of `x` has no boundary in it, so the cut lands exactly on the cap — which
    /// is the branch of the boundary rule this case is pinning.
    #[test]
    fn an_overlong_message_is_clipped_rather_than_refused() {
        let long = "x".repeat(MAX_BODY + 500);
        let e = envelope(&wall()[0], &long);
        assert!(e.contains("clipped by the wall"), "{e}");
        assert!(e.contains("500 of"), "the loss was not named: {e}");
        assert!(e.contains("`mcp__skein__send`"), "no way to ask for the rest: {e}");
        assert!(e.matches('x').count() == MAX_BODY);
    }

    #[test]
    fn the_rate_limit_lets_six_through_and_then_says_how_long_to_wait() {
        let relays = Relays::default();
        for _ in 0..MAX_SENDS {
            assert!(throttled(&relays, "a").is_none());
        }
        let wait = throttled(&relays, "a").expect("the seventh is refused");
        assert!(wait > 0 && wait <= SEND_WINDOW.as_secs() + 1);
        // Per card, not per wall — one busy card must not silence another.
        assert!(throttled(&relays, "b").is_none());
    }

    #[test]
    fn a_list_with_nobody_in_it_is_an_error_rather_than_an_empty_send() {
        assert!(targets(&wall(), "aaaaaaaa", &json!([])).is_err());
        assert!(targets(&wall(), "aaaaaaaa", &json!(7)).is_err());
    }

    #[test]
    fn both_tools_advertise_what_they_take() {
        let l = list_schema();
        assert_eq!(l["name"], LIST_TOOL);
        assert_eq!(l["inputSchema"]["properties"]["scope"]["enum"][0], "project");
        // Scope is optional: the default is the answer nearly every agent wants,
        // and a required field would refuse the call that just asks.
        assert!(l["inputSchema"]["required"].is_null());

        let s = send_schema();
        assert_eq!(s["name"], SEND_TOOL);
        assert_eq!(s["inputSchema"]["required"], json!(["to", "message"]));
        // Several recipients in one call, which is what makes a broadcast one
        // send rather than N against the rate limit.
        assert!(s["inputSchema"]["properties"]["to"]["anyOf"][1]["items"].is_object());
    }
}
