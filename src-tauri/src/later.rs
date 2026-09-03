//! A message to yourself, later.
//!
//! The worst thing a card can do with its turn is spend it waiting. An agent
//! watching a deploy, a CI run, a long build has exactly one move available to
//! it today: park a `Bash` call on a `sleep` and hold the whole turn — its
//! context, its process, and the user's attention — doing nothing. Ten minutes
//! of that is ten minutes of a card that looks alive and is not.
//!
//! `wake_me` is the other way round. The turn *ends*, the wall keeps the note,
//! and when the time comes the card is handed a prompt exactly as if somebody
//! had typed it. Nothing is held open in between.
//!
//! **It reuses the relay's delivery, deliberately and completely.** A card being
//! handed a prompt it did not type is a thing this codebase has already got
//! right once — the marker in the text, the fold that recognises it, the inbox
//! for a card that is not there to take it — and a second mechanism beside it
//! would be a second thing for `relay.ts` to learn to draw. So a wake is a
//! relay from the card to itself, with the one difference that makes it not a
//! self-send: `relay::do_send` refuses those, because a self-send is a send that
//! should have been a thought. A self-send *across time* is the opposite; it is
//! the only way to have a thought later.
//!
//! ### The loop this has to survive
//!
//! Not a lost wake. A card that re-arms on every wake, forever, at a turn and an
//! API call apiece, with nothing on the wall saying where the allowance went —
//! which is the same failure `relay.rs`'s guards exist for, arriving by a
//! different road. The hop counter cannot see it: every wake is hop zero,
//! because the card is talking to itself.
//!
//! So the guard is a rate rather than a depth. `MAX_SERVED` wakes per card per
//! hour, counted on *delivery* rather than on arming, and the refusal says to
//! stop and tell the user — for `MAX_HOPS`' reason, that an agent told only "no"
//! tries a different phrasing of the same thing. A card that genuinely needs to
//! watch something for an hour can, at five-minute intervals, which is the
//! honest cadence for anything a human would also be watching.

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::store::Store;

pub const WAKE_TOOL: &str = "wake_me";

/// The soonest a wake may be asked for.
///
/// Thirty seconds. Below that the round trip — end the turn, be woken, read the
/// prompt, look again — costs more than it saves, and an agent asking for five
/// seconds wants a `sleep` and should be told so.
const MIN_DELAY_S: i64 = 30;

/// The furthest out one may be asked for.
///
/// Twelve hours. Long enough for "look at this after lunch" and short enough
/// that nothing in this table is a reminder about next week — that is what the
/// sink is for, and an item there does not cost a turn when it comes due.
const MAX_DELAY_S: i64 = 12 * 60 * 60;

/// How many wakes one card may have armed at once. Three is more than a piece of
/// work needs and few enough that a card cannot fill an afternoon with them.
const MAX_ARMED: i64 = 3;

/// How many wakes one card may be *served* in an hour. See the module note: this
/// is the guard, and it is the only one that can see a re-arming loop.
const MAX_SERVED: i64 = 12;
const SERVED_WINDOW_MS: i64 = 60 * 60 * 1_000;

const MAX_NOTE: usize = 1_200;

/// How often the table is looked at.
///
/// Five seconds. The delays here are minutes, so the granularity is invisible,
/// and a tick this cheap — one indexed query against a table that is empty on
/// most walls — is not worth being clever about. It is a poll, and it is the
/// third deliberate one in this codebase for the same reason as the other two:
/// **there is no event to subscribe to.** A moment arriving is not something
/// that happens to anything.
const TICK: std::time::Duration = std::time::Duration::from_secs(5);

pub fn wake_schema() -> Value {
    json!({
        "name": WAKE_TOOL,
        "description":
            "End your turn now and be handed a prompt later. Skein keeps the note and \
             gives it to this conversation when the time comes, exactly as though the \
             user had typed it.\n\n\
             **This is what to do instead of sleeping.** Waiting inside a turn — a `sleep` \
             in a shell call, a poll loop — holds your context, your process and the \
             user's attention for the whole wait and does no work in it. Reach for this \
             whenever the next useful thing cannot happen yet: a deploy in flight, a CI \
             run, a build, a rate limit that clears at a known time, anything you have \
             been asked to check on later.\n\n\
             Say in your `note` everything you will need, because you will have moved on: \
             what you were doing, what you are waiting for, and how to tell whether it \
             worked. Then finish your turn and tell the user when you will look again.\n\n\
             **Not for a reminder about next week** — use `drop` to put that in the sink, \
             where it costs no turn when it comes due. This is for a wait you are in the \
             middle of.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "seconds": {
                    "type": "integer",
                    "description":
                        "How long to wait, in seconds. Between 30 and 43200 (twelve \
                         hours). Match it to the thing you are waiting for — a CI run \
                         that takes eight minutes wants one look at 480s, not eight \
                         looks a minute apart."
                },
                "note": {
                    "type": "string",
                    "description":
                        "What to hand you when the time comes. Write it to a stranger: \
                         you will have no memory of this turn beyond what is in the \
                         transcript, so name the file, the pipeline, the command to \
                         re-run and what a good answer looks like."
                }
            },
            "required": ["seconds", "note"]
        }
    })
}

/// The first line of a wake, and how the front end knows one.
///
/// A relay's own mark would be a lie — `relay.ts` reads a sender's name out of
/// that envelope and there is nobody at the other end of this. Its own words, so
/// the fold can tell "another agent asked me to" from "I asked myself to",
/// which are different things for a reader of the transcript to know.
///
/// **That reasoning is right and it stopped one step short for a fortnight.**
/// Nothing in `src/` knew this string, so a wake fell through to the plain
/// `user` arm and was drawn in your own register — the one outcome the mark
/// exists to prevent, reached by not being read rather than by being read
/// wrongly. Fixed 2026-08-28 (sink af952612): `relay.ts` exports `WAKE_MARK`
/// against this constant and `isRelayPrompt` answers to both marks, so the
/// panel says "this was not you" for a wake as it does for a relay, and
/// `relayFrom` names the author as you-earlier rather than as another card.
///
/// So a new mark is affordable, and the bill is two lines in `relay.ts` — but
/// it is only affordable if it is paid. **Anything here that ever invents a
/// third mark owes the same edit in the same commit.**
pub const WAKE_MARK: &str = "[skein wake]";

fn envelope(note: &str, waited: i64) -> String {
    format!(
        "{WAKE_MARK} you asked to be woken about this {}, and it is now:\n\n{note}\n\n\
         (This is your own note to yourself, handed back by the wall — nobody else \
         wrote it and nobody is waiting on a reply. If the thing you were waiting for \
         still has not happened, `wake_me` again rather than sleeping; if it has, carry \
         on and say so.)",
        said(waited)
    )
}

fn said(secs: i64) -> String {
    if secs < 90 {
        return format!("{secs} seconds ago");
    }
    let mins = secs / 60;
    if mins < 90 {
        return format!("{mins} minutes ago");
    }
    format!("{} hours ago", mins / 60)
}

fn do_wake(app: &AppHandle, caller: &str, args: &Value) -> String {
    let secs = args
        .get("seconds")
        .and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)));
    let Some(secs) = secs else {
        return "no `seconds` was given, so nothing was armed".into();
    };
    /* Clamped rather than refused, in both directions. An agent whose wake was
       bounced asks again with a different number and spends a turn discovering
       the range; a clamp costs it nothing and the receipt says what it got. */
    let asked = secs;
    let secs = secs.clamp(MIN_DELAY_S, MAX_DELAY_S);
    let note = args
        .get("note")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if note.is_empty() {
        return "no `note` was given — a wake with nothing in it is a turn spent \
                rediscovering why you armed it, so nothing was armed"
            .into();
    }
    let note = crate::clip::keep(note, MAX_NOTE).marked(
        "You wrote this to yourself and the wall could not carry all of it. Whatever the \
         rest said, do not infer it — say plainly that the note arrived incomplete.",
    );

    let Some(store) = app.try_state::<Store>() else {
        return "the store is unavailable".into();
    };
    let Ok(conn) = store.0.lock() else {
        return "the store is unavailable".into();
    };
    let now = crate::store::now();
    if crate::store::wakes_armed_by(&conn, caller) >= MAX_ARMED {
        return format!(
            "this conversation already has {MAX_ARMED} wakes armed, which is the limit. \
             Wait for one of them rather than arming another."
        );
    }
    /* The loop guard, checked on arming as well as on serving so a card in one is
       told *now* rather than being armed and refused later with nothing left to
       do about it. */
    let served = crate::store::wakes_served_to(&conn, caller, now - SERVED_WINDOW_MS);
    if served >= MAX_SERVED {
        return format!(
            "this conversation has already been woken {served} times in the last hour, \
             which is the limit — that is the shape of a loop rather than of waiting for \
             something. Stop, and tell the user what you are waiting for and that you \
             have stopped watching it."
        );
    }
    let id = crate::store::uuid_v4();
    let due = now + secs * 1_000;
    let armed = crate::store::arm_wake(&conn, &id, caller, due, &note);
    drop(conn);

    match armed {
        Err(e) => format!("could not arm that: {e}"),
        Ok(()) => {
            let clamped = if asked != secs {
                format!(
                    " You asked for {asked}s; the range here is {MIN_DELAY_S}–{MAX_DELAY_S}, \
                     so it was set to {secs}s."
                )
            } else {
                String::new()
            };
            format!(
                "armed — this conversation will be handed that note in {}.{clamped} End \
                 your turn now: nothing is gained by waiting for it, and the note will \
                 arrive whether or not you are mid-anything. Tell the user when you will \
                 look again.",
                said(secs)
            )
        }
    }
}

/* `later.rs` has no clipper of its own any more. It had the silent kind, and a
   wake note is the worst of the silent cases in one specific way: the note is
   written *to yourself*, by a card that will have moved on and whose only
   record of what it was waiting for is this text. A tail lost here is a card
   waking up with instructions that stop mid-sentence and no author to ask.
   `crate::clip` cuts at a boundary and says what went. */

/* ── the tick ─────────────────────────────────────────────────────────────── */

/// Hand out whatever has come due, forever.
///
/// Started in `setup` beside `perf::spawn_reaper`, and for that function's
/// reason: a guarantee that holds only while something is watching is not one.
/// A wake armed at four o'clock has to arrive at ten past whether or not the
/// panel is open, whether or not a widget is up, and whether or not anybody has
/// looked at the wall since.
pub fn spawn_waker(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(TICK);
        serve_due(&app);
        /* The other thing in this codebase whose only remaining question is
           whether a moment has arrived — a parent waiting to be told its
           children have stopped (`spawn::sweep`). It rides this tick rather
           than starting one of its own: the delays there are minutes against
           this five seconds, and a second thread doing the identical thing at
           the identical interval would be a second thing to get wrong. Nothing
           is polled *for* — the settle itself is folded off `persist_turn`. */
        crate::spawn::sweep(&app);
    });
}

fn serve_due(app: &AppHandle) {
    let Some(store) = app.try_state::<Store>() else { return };
    let now = crate::store::now();
    let due = {
        let Ok(conn) = store.0.lock() else { return };
        crate::store::wakes_due(&conn, now)
    };
    for w in due {
        /* Taken before it is delivered, and that ordering is the whole of what
           stops a wake being served twice. A delivery is a write to a pipe and a
           turn; if this thread were interrupted between the two, losing one wake
           is a card that waits for nothing, where serving it twice is a card
           handed the same prompt in a loop — and the second is the failure this
           file's guards exist to prevent. Same shape as `store::set_mid_turn`'s
           lesson: bookkeeping about how far something got is written when it
           happens. */
        {
            let Ok(conn) = store.0.lock() else { return };
            if !crate::store::take_wake(&conn, &w.id) {
                /* Another pass had it. Cannot happen with one thread, and is
                   cheap insurance against there ever being two. */
                continue;
            }
        }
        let waited = ((now - w.armed_at).max(0)) / 1_000;
        let text = envelope(&w.note, waited);
        let delivered = crate::supervisor::deliver(app, &w.conversation_id, &text).is_ok();
        if !delivered {
            /* Dormant: it goes to the inbox the relay already drains on spawn,
               rather than rousing the card. A wake is armed by a card that is
               live — going dormant in between means Skein restarted — so this
               is the rare path, and the rule `relay.md` states holds here too:
               spending a process and an API turn on a sleeping card without
               anybody asking is the wrong default. It arrives when the card
               next wakes, which is when anybody is there to read it.

               `record_relay` with the card as its own sender: the row is what
               `spawn_conversation` drains, and nothing about that path cares
               that the two ids are the same. */
            let Ok(conn) = store.0.lock() else { continue };
            let _ = crate::store::record_relay(
                &conn,
                &crate::store::uuid_v4(),
                &w.conversation_id,
                &w.conversation_id,
                &text,
                &w.id,
                0,
                false,
            );
        }
        {
            let Ok(conn) = store.0.lock() else { continue };
            crate::store::record_wake_served(&conn, &w.conversation_id, now);
        }
    }
}

/// Route a `tools/call` that belongs here.
pub fn handle(app: &AppHandle, conversation_id: &str, tool: &str, args: &Value) -> Option<String> {
    (tool == WAKE_TOOL).then(|| do_wake(app, conversation_id, args))
}

/// A card is going, or has been cleared. Its wakes go with it: a note to
/// yourself is worth nothing once there is no self to hand it to, and a card
/// that has been reset is not the conversation that armed it.
pub fn clear_for(app: &AppHandle, conversation_id: &str) {
    let Some(store) = app.try_state::<Store>() else { return };
    let Ok(conn) = store.0.lock() else { return };
    crate::store::drop_wakes_of(&conn, conversation_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tool_says_what_it_replaces() {
        let s = wake_schema();
        assert_eq!(s["name"], WAKE_TOOL);
        let d = s["description"].as_str().unwrap();
        /* The sentence that makes it worth having. An agent that does not know
           this replaces a `sleep` will go on sleeping. */
        assert!(d.contains("instead of sleeping"), "{d}");
        assert!(d.contains("End your turn") || d.contains("finish your turn"), "{d}");
        /* And the boundary with the sink, or every long-dated reminder becomes a
           wake that costs a turn to deliver. */
        assert!(d.contains("`drop`"), "{d}");
    }

    #[test]
    fn the_range_is_a_wait_rather_than_a_calendar() {
        assert_eq!(MIN_DELAY_S, 30);
        assert_eq!(MAX_DELAY_S, 12 * 60 * 60);
        assert!(MAX_SERVED * 5 * 60 >= 60 * 60, "an hour's watching at 5m apart must fit");
    }

    #[test]
    fn a_wake_is_marked_as_its_own_thing() {
        let text = envelope("check whether the pipeline went green", 600);
        assert!(text.starts_with(WAKE_MARK));
        assert!(!text.contains(crate::relay::RELAY_MARK), "not a message from anybody");
        assert!(text.contains("check whether the pipeline went green"));
        /* It says how long ago, because a note handed back with no elapsed time
           reads as something that just happened. */
        assert!(text.contains("10 minutes ago"), "{text}");
        /* And that nobody is waiting on a reply, or the agent answers it. */
        assert!(text.contains("nobody is waiting"));
    }

    /// The other end of this envelope is a regex in `src/lib/relay.ts`, and
    /// there is nothing to import across that seam — only the two agreeing.
    /// They did not agree for a fortnight and nothing said so, because
    /// disagreeing costs no error: the front end simply drew the wake as
    /// something the user typed (sink af952612).
    ///
    /// So the *shape* is asserted here rather than only the mark. `relay.ts`'s
    /// `WAKE` matches the first line whole and lifts the elapsed phrase out of
    /// it for the fold cap; `relayBody` drops the trailing paragraph by its
    /// opening words. Both are pinned by `test/relay.test.ts`'s `woken()`, and
    /// this is the half of the pair that lives beside the writer.
    #[test]
    fn the_envelope_is_the_shape_the_front_end_parses() {
        let text = envelope("look at the deploy", 600);
        let head = text.lines().next().expect("a first line");
        assert_eq!(
            head, "[skein wake] you asked to be woken about this 10 minutes ago, and it is now:",
            "relay.ts's WAKE regex matches this line whole — if it changes, change both"
        );
        assert!(
            text.contains("\n\n(This is your own note to yourself"),
            "relayBody drops the model's paragraph by these words: {text}"
        );
    }

    #[test]
    fn the_elapsed_time_is_said_at_every_scale() {
        assert_eq!(said(45), "45 seconds ago");
        assert_eq!(said(600), "10 minutes ago");
        assert_eq!(said(4 * 3600), "4 hours ago");
    }
}
