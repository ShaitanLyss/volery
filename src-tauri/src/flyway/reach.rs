//! Reaching a card on another wall: the tool side.
//!
//! `spawn{host}` could put a card on another machine and then nothing could
//! touch it — `send`, `recall` and `close` all said, in so many words, that they
//! did not cross. An orchestrator that can open work it cannot steer, read or
//! tidy away is a spawn button, and this is what makes it the other thing.
//!
//! **The three tools keep their names and grow one argument.** `host` says
//! which wall; without it, or naming this one, each does exactly what it always
//! did — so nothing a card already knows changes, and the extra word is the
//! whole of what it has to learn. A fourth tool, `walls`, is how it finds out
//! what to put there.
//!
//! What each guards is said where it is decided, and only the parts that are
//! about *asking* are here:
//!
//! - **Who may is decided by the wall the card is on**, never here: `fleet::
//!   may_reach`, with the far wall's own record of who asked for the card. This
//!   side refuses only what it can already see would go nowhere — a chat card,
//!   no flyway, a wall it does not know or has not heard from, one too old to
//!   understand the request (`Fleet::reach`) — and says so at once.
//! - **Nothing is queued for a wall that is down.** A message delivered when a
//!   lid lifts eight hours later is something somebody has since changed their
//!   mind about, onto a card with the machine in its hands (a2a4468e's rule for
//!   a person's prompt, which is the same act).
//! - **The call waits for the answer, briefly**, where a `send` on this wall
//!   returns at once. Delivery here is a function call and cannot be refused
//!   by anything but the caller's own mistake; there, the far wall's switch,
//!   its roster and its clock all get a say, and a send whose refusal arrived
//!   after the call returned would be a report the agent believes was made.
//!   Half a minute — a few hundred milliseconds is usual — and past it the
//!   agent is told plainly that nobody has said, and what will tell it later.
//! - **One card per send, and no broadcast.** `project` and `skein` mean this
//!   wall's cards; a fan-out across machines is a thing to do one deliberate
//!   call at a time, where the rate limit (`relay::count_send`) still counts.

use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use super::fleet::{Act, PromptRequest};
use crate::store::Store;

pub const WALLS_TOOL: &str = "walls";

/// How long a send, a recall or a close waits for the far wall. See the module
/// note; the far wall answers a send and a close the moment it has decided, and
/// a recall once it has read the file.
const WAIT: Duration = Duration::from_secs(30);

/// What a cross-wall call does with the `tools/call`: answer now, or park.
pub enum Afar {
    Now(String),
    Wait { rx: std::sync::mpsc::Receiver<String>, waiting: String, timeout: String, window: Duration },
}

/// The wall `host` names, if it names one other than this — the same reading
/// `spawn::names_another_wall` makes, so `host` means one thing on all four
/// tools.
fn elsewhere(args: &Value) -> Option<String> {
    crate::spawn::names_another_wall(args)
        .then(|| args.get("host").and_then(Value::as_str).unwrap_or("").trim().to_string())
}

/// `send`, `recall` or `close` naming another wall, or `None` for anything
/// this file does not answer — which goes on down the chain exactly as it did.
pub fn afar(app: &AppHandle, caller: &str, tool: &str, args: &Value) -> Option<Afar> {
    let act = match tool {
        crate::relay::SEND_TOOL => Act::Prompt,
        crate::relay::RECALL_TOOL => Act::Recall,
        crate::spawn::CLOSE_TOOL => Act::Close,
        _ => return None,
    };
    let host = elsewhere(args)?;
    Some(reach(app, caller, act, &host, args))
}

fn reach(app: &AppHandle, caller: &str, act: Act, host: &str, args: &Value) -> Afar {
    let me = {
        let Some(store) = app.try_state::<Store>() else {
            return Afar::Now("the store is unavailable".into());
        };
        let Ok(conn) = store.0.lock() else {
            return Afar::Now("the store is unavailable".into());
        };
        crate::store::roster_one(&conn, caller)
    };
    let Some(me) = me else {
        return Afar::Now("this card is not on the wall, so it has nowhere to reach from".into());
    };
    /* `relay.rs`'s gate, for its reason and with a network in the middle: a
       chat card reaches the open web and nothing on any machine. */
    if me.kind == "chat" {
        return Afar::Now(
            "this is a chat card: it stands outside the wall's projects and reaches no card on \
             any machine. Tell the user what you wanted done, and where."
                .into(),
        );
    }
    let Some(link) = crate::flyway::link::link(app) else {
        return Afar::Now(
            "this wall is not on a flyway, so it has no other machines to reach — the user joins \
             one from the flyway panel (space then k). Leave `host` out to mean this wall."
                .into(),
        );
    };

    let (card, text) = match act {
        Act::Prompt => {
            let to = match args.get("to") {
                Some(Value::String(s)) => s.trim().to_string(),
                Some(Value::Array(_)) => {
                    return Afar::Now(format!(
                        "with `host`, `to` is one card on {host}, by its handle — send to each \
                         one in its own call, so each answer says whether it arrived"
                    ))
                }
                _ => return Afar::Now("no `to` was given, so nothing was sent".into()),
            };
            if matches!(to.to_lowercase().as_str(), "project" | "skein") {
                return Afar::Now(format!(
                    "`{to}` reaches this wall's cards and no other's, so nothing was sent — name \
                     the card on {host} by its handle (the `mcp__skein__walls` tool lists them)"
                ));
            }
            let Some(body) = args.get("message").and_then(Value::as_str).filter(|b| !b.trim().is_empty()) else {
                return Afar::Now("the message was empty, so nothing was sent".into());
            };
            if let Err(why) = crate::relay::count_send(app, caller) {
                return Afar::Now(why);
            }
            (to, body.to_string())
        }
        Act::Recall | Act::Close => match args.get("card").and_then(Value::as_str).map(str::trim) {
            Some(c) if !c.is_empty() => (c.to_string(), String::new()),
            _ => {
                return Afar::Now(format!(
                    "name the card on {host} by its handle — the one `mcp__skein__spawn` \
                     returned, or one the `mcp__skein__walls` tool lists"
                ))
            }
        },
    };
    if card.is_empty() {
        return Afar::Now("no card was named, so nothing was sent".into());
    }

    let request = PromptRequest {
        id: crate::store::uuid_v4(),
        from_card: Some(caller.to_string()),
        to: host.to_string(),
        card: card.clone(),
        text,
        answers: None,
        title: Some(me.title.clone()).filter(|t| !t.trim().is_empty()),
        project: Some(me.project.clone()).filter(|p| !p.trim().is_empty()),
    };
    match link.reach_card(act, request) {
        Ok(rx) => Afar::Wait {
            rx,
            waiting: match act {
                Act::Prompt => format!("waiting for {host} to say it has the message"),
                Act::Recall => format!("waiting for {host} to read {card}"),
                Act::Close => format!("waiting for {host} to close {card}"),
            },
            timeout: unanswered(act, host, &card),
            window: WAIT,
        },
        Err(why) => Afar::Now(match act {
            Act::Prompt => format!("nothing was sent: {why}"),
            Act::Recall => format!("nothing was read: {why}"),
            Act::Close => format!("nothing was closed: {why}"),
        }),
    }
}

/// What the parked call says when the far wall has not answered in time —
/// which is not the same as it having refused, and must not read as it.
fn unanswered(act: Act, host: &str, card: &str) -> String {
    match act {
        Act::Prompt => format!(
            "{host} has not said whether {card} has your message. It may still arrive. If {host} \
             refuses it, you will be told by a message from the wall; if nothing comes, nobody \
             knows whether it arrived. **Do not send it again** without checking first — \
             `mcp__skein__recall` it with the same `host` — because if the first one landed, a \
             second is a second turn on that card."
        ),
        Act::Recall => format!(
            "{host} did not answer the recall of {card} in time — it may be asleep, off the \
             network, or slow to read a long transcript. Nothing was read; try again in a while."
        ),
        Act::Close => format!(
            "{host} has not answered yet. If it closes {card}, or refuses to, you will be told by a \
             message from the wall; if nothing comes, `mcp__skein__walls` shows whether it is still \
             there. Do not ask again before looking."
        ),
    }
}

/* ── walls ─────────────────────────────────────────────────────────────── */

pub fn walls_schema() -> Value {
    json!({
        "name": WALLS_TOOL,
        "description":
            "The other walls on this flyway — the user's other machines running Volery — and \
             the cards each one shows: what `host` can name, and what `send`, `recall` and \
             `close` can reach there with it.\n\n\
             Per wall: whether it has been heard from lately, whether it takes work from other \
             walls (a person's switch on that machine — without it a wall takes only answers, \
             reports from cards it opened, and reads and closes by the card that opened one), \
             its territories (what `spawn` with `host` may name as `project`), and its cards \
             with their handles, as that wall last described them. Cards you opened there are \
             marked `yours`; the card that opened you, if another wall asked for you, is marked \
             `opened_you`.\n\n\
             A wall not heard from for a minute and a half is marked quiet, and its cards are \
             then only what it last said — a lid shut mid-turn looks exactly like a card still \
             working. Nothing can be sent to a quiet wall.",
        "inputSchema": { "type": "object", "properties": {} }
    })
}

/// The tools this file answers on the chain — `walls` alone; the other three
/// are routed by `ask.rs` ahead of it, because they may park.
pub fn handle(app: &AppHandle, caller: &str, tool: &str, _args: &Value) -> Option<String> {
    (tool == WALLS_TOOL).then(|| do_walls(app, caller))
}

fn do_walls(app: &AppHandle, caller: &str) -> String {
    let Some(store) = app.try_state::<Store>() else {
        return "the store is unavailable".into();
    };
    let (kind, children, born) = {
        let Ok(conn) = store.0.lock() else {
            return "the store is unavailable".into();
        };
        (
            crate::store::roster_one(&conn, caller).map(|r| r.kind),
            super::here::children_of(&conn, caller),
            super::here::birth_of(&conn, caller),
        )
    };
    /* `list`'s refusal, a machine further out: the roster of every wall is a
       list of the user's machines and the directories on them. */
    if kind.as_deref() == Some("chat") {
        return "this is a chat card: it stands outside the wall's projects and cannot see the \
                other walls."
            .into();
    }
    let Some(link) = crate::flyway::link::link(app) else {
        return "this wall is not on a flyway — there are no other walls to show. The user joins \
                one from the flyway panel (space then k)."
            .into();
    };
    let seen = link.walls_seen();
    walls_answer(link.me(), &seen, &children, born.as_ref()).to_string()
}

/// One wall as `walls` shows it, before it is shaped for the agent.
pub struct WallSeen {
    pub host: String,
    pub standing: &'static str,
    pub quiet_ms: u64,
    pub accepting: bool,
    pub territories: Vec<String>,
    pub cards_live: u32,
    pub cards_working: u32,
    pub can: Vec<String>,
    /// That wall's latest cards snapshot, opaque — see `cards_in`.
    pub snapshot: Option<Value>,
}

/// The answer, shaped. Pure, so what an agent is told about a wall is a thing a
/// test can hold.
pub fn walls_answer(
    me: &str,
    seen: &[WallSeen],
    children: &[super::here::Child],
    born: Option<&super::here::Birth>,
) -> Value {
    let walls: Vec<Value> = seen
        .iter()
        .filter(|w| w.host != me)
        .map(|w| {
            let quiet = w.standing == "quiet";
            let cards: Vec<Value> = w
                .snapshot
                .as_ref()
                .map(cards_in)
                .unwrap_or_default()
                .into_iter()
                .map(|c| {
                    let mut row = json!({
                        "handle": crate::relay::handle_of(&c.id),
                        "name": c.title,
                        "project": c.project,
                        /* The owner's word, as sent, never re-derived here —
                           and claiming nothing once the wall is quiet. */
                        "state": if quiet { "unknown".to_string() } else { c.state },
                    });
                    if let Some(obj) = row.as_object_mut() {
                        if children.iter().any(|k| k.host == w.host && k.card == c.id) {
                            obj.insert("yours".into(), Value::Bool(true));
                        }
                        if born.is_some_and(|b| b.host == w.host && b.asker_card.as_deref() == Some(c.id.as_str())) {
                            obj.insert("opened_you".into(), Value::Bool(true));
                        }
                    }
                    row
                })
                .collect();
            let mut row = json!({
                "host": w.host,
                "heard": if quiet { "quiet" } else { "lately" },
                "takes_work": w.accepting,
                "territories": w.territories,
                "cards_open": w.cards_live,
                "cards_working": w.cards_working,
                "cards": cards,
            });
            if let Some(obj) = row.as_object_mut() {
                if quiet {
                    obj.insert(
                        "note".into(),
                        Value::String(format!(
                            "not heard from for {}s — nothing can be sent to it, and its cards are \
                             only what it last said",
                            w.quiet_ms / 1000
                        )),
                    );
                } else if !super::fleet::CAN.iter().all(|c| w.can.iter().any(|x| x == c)) {
                    obj.insert(
                        "note".into(),
                        Value::String(
                            "an older Volery: a card here cannot send to, recall or close its cards \
                             until it is updated"
                                .into(),
                        ),
                    );
                }
            }
            row
        })
        .collect();
    json!({ "this_wall": me, "walls": walls })
}

/// One card out of a snapshot.
pub struct SeenCard {
    pub id: String,
    pub title: String,
    pub project: String,
    pub state: String,
}

/// The four fields `walls` needs, read out of the snapshot the owning wall's
/// front end composed.
///
/// **This is the one place Rust looks inside it**, and it keeps the bargain
/// `cards.rs` and `elsewhere.md` strike rather than breaking it: nothing is
/// re-derived and nothing is required. The tier is the owner's word passed on
/// as a string; a field that is missing or the wrong type reads as empty; a
/// card with no id is skipped, since it is one nothing could address; every
/// string is scrubbed and capped, because it goes into an agent's context and
/// the far wall is a different build. A newer build's fields cost nothing.
pub fn cards_in(snapshot: &Value) -> Vec<SeenCard> {
    const MOST: usize = 200;
    const TEXT: usize = 120;
    let text = |c: &Value, k: &str| -> String {
        let s = c.get(k).and_then(Value::as_str).unwrap_or("");
        crate::clean::scrub(s).chars().take(TEXT).collect()
    };
    let Some(cards) = snapshot.get("cards").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut seen: Vec<String> = Vec::new();
    cards
        .iter()
        .filter_map(|c| {
            let id = text(c, "id");
            if id.is_empty() || seen.contains(&id) {
                return None;
            }
            seen.push(id.clone());
            let flag = |k: &str| c.get(k).and_then(Value::as_bool).unwrap_or(false);
            let state = if flag("working") {
                "working".to_string()
            } else if flag("dormant") {
                "dormant".to_string()
            } else {
                let tier = text(c, "tier");
                if tier.is_empty() { "idle".to_string() } else { tier }
            };
            Some(SeenCard { id, title: text(c, "title"), project: text(c, "project"), state })
        })
        .take(MOST)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flyway::here::{Birth, Child};

    fn wall(host: &str, standing: &'static str, snapshot: Value) -> WallSeen {
        WallSeen {
            host: host.into(),
            standing,
            quiet_ms: 95_000,
            accepting: false,
            territories: vec!["skein".into()],
            cards_live: 2,
            cards_working: 1,
            can: crate::flyway::fleet::CAN.iter().map(|c| c.to_string()).collect(),
            snapshot: Some(snapshot),
        }
    }

    /// The snapshot is read for four fields and nothing more is asked of it:
    /// a card with no id is skipped, a repeated one is one, a missing field is
    /// empty, a newer build's extra field is ignored, and an impossible
    /// character never reaches the agent.
    #[test]
    fn a_snapshot_is_read_leniently_and_never_trusted_with_a_character() {
        let snap = json!({ "v": 9, "cards": [
            { "id": "0cf05791-aaaa", "title": "build\u{0}er", "project": "skein", "tier": "asking", "future": [1] },
            { "id": "0cf05791-aaaa", "title": "twin" },
            { "title": "no id" },
            { "id": "4bd5340b-bbbb", "working": true, "tier": "rest" },
            { "id": "f618d9b7-cccc", "dormant": true, "title": 7 },
        ]});
        let cards = cards_in(&snap);
        assert_eq!(cards.len(), 3);
        assert_eq!((cards[0].title.as_str(), cards[0].state.as_str()), ("builder", "asking"));
        assert_eq!(cards[1].state, "working");
        assert_eq!((cards[2].title.as_str(), cards[2].state.as_str()), ("", "dormant"));
        assert!(cards_in(&json!({ "cards": "nope" })).is_empty());
        assert!(cards_in(&Value::Null).is_empty());
    }

    /// What an orchestrator needs to find its own: the cards it opened marked
    /// `yours`, the card that opened it marked `opened_you` — and a quiet
    /// wall's cards claiming nothing, since a shut lid looks like work.
    #[test]
    fn walls_marks_your_children_your_origin_and_a_quiet_wall() {
        let snap = json!({ "cards": [
            { "id": "child-1", "title": "a", "working": true },
            { "id": "parent-1", "title": "b", "tier": "rest" },
        ]});
        let seen = vec![wall("me", "open", json!({})), wall("box", "open", snap.clone()), wall("lap", "quiet", snap)];
        let children = vec![Child { host: "box".into(), card: "child-1".into(), parent: "caller".into() }];
        let born = Birth { card: "caller".into(), host: "box".into(), asker_card: Some("parent-1".into()) };
        let v = walls_answer("me", &seen, &children, Some(&born));
        let walls = v["walls"].as_array().unwrap();
        assert_eq!(walls.len(), 2, "this wall is not one of the others");
        let bx = &walls[0];
        assert_eq!(bx["cards"][0]["yours"], true);
        assert_eq!(bx["cards"][0]["state"], "working");
        assert_eq!(bx["cards"][1]["opened_you"], true);
        assert!(bx.get("note").is_none());
        let lap = &walls[1];
        assert_eq!(lap["heard"], "quiet");
        assert_eq!(lap["cards"][0]["state"], "unknown");
        assert!(lap["cards"][0].get("yours").is_none(), "a card of the same id on another wall is not yours");
        assert!(lap["note"].as_str().unwrap().contains("nothing can be sent"));
    }

    /// A wall that does not announce every word is said to be older, so an
    /// agent is told before it tries rather than after.
    #[test]
    fn an_older_wall_is_named_as_one() {
        let mut old = wall("old", "open", json!({ "cards": [] }));
        old.can.clear();
        let v = walls_answer("me", &[old], &[], None);
        assert!(v["walls"][0]["note"].as_str().unwrap().contains("older Volery"));
    }

    #[test]
    fn walls_names_what_host_reaches_and_what_quiet_means() {
        let d = walls_schema()["description"].as_str().unwrap().to_string();
        /* Words rather than the backticked names, which the result guards in
           `supervisor.rs` would read as a bare tool name in a tool result. */
        assert!(d.contains("`host` can name") && d.contains("reach there with it"), "{d}");
        assert!(d.contains("quiet") && d.contains("`yours`") && d.contains("`opened_you`"), "{d}");
    }
}
