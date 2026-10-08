//! The `ask_user` tool — Skein hosting the question the CLI can't offer.
//!
//! `AskUserQuestion` and `ExitPlanMode` do not exist in headless mode (probed:
//! absent from the tool list, and `--tools` silently drops them when named).
//! So rather than wait for them, we provide our own over MCP.
//!
//! The shape that makes this good is the parking. A `tools/call` blocks the
//! HTTP request until the UI answers it, which means the agent is genuinely
//! *stopped* rather than idle, and when the answer arrives the turn continues
//! where it left off instead of restarting. Amber stops being an inference
//! about silence and becomes a fact.
//!
//! Protocol confirmed against claude 2.1.227: plain JSON-RPC over POST, no SSE
//! required. The client also issues one GET, which we may refuse.
//!
//! *Not* required, but a question is answered with one anyway, and that is not
//! a protocol preference — it is the only way a park can outlive five minutes.
//! See `FEED_EVERY`.

use std::collections::HashMap;
use std::io::Write;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

/// How long a question waits before the agent is told to carry on without you.
///
/// Blocking forever would be worse than it sounds: the turn holds its context,
/// and a question you never noticed becomes an agent wedged until you quit. Ten
/// minutes is long enough to be away from the desk and short enough that a
/// forgotten card unsticks itself.
///
/// **It is a floor rather than the deadline**, and it was the deadline for the
/// whole of this feature's life. A flat ten minutes is generous for one yes/no
/// and tight for a genuine review: a call carrying five questions, each with
/// three or four options, context and pros and cons per option, expired with the
/// user *still reading it* — "ah it timed out, ask again, I was almost done"
/// (sink `d2adbf74`). They answered all five immediately when re-asked, which is
/// the evidence the clock was the only thing wrong. A deadline that does not
/// scale with the payload is a deadline that means two different things
/// depending on what was asked.
const ANSWER_BASE: Duration = Duration::from_secs(600);

/// What each question past the first adds. Not each question: the first one is
/// what `ANSWER_BASE` already pays for.
const ANSWER_PER_QUESTION: Duration = Duration::from_secs(180);

/// What each option adds, over every question in the call.
///
/// The reading load is not the question count, it is the options — one decision
/// between eight described alternatives is a longer read than four plain
/// yes/nos, and `option_schema` asks for a `detail` line on each precisely so
/// they are worth reading. Twenty seconds apiece is what a `label` and a
/// `detail` cost to take in.
const ANSWER_PER_OPTION: Duration = Duration::from_secs(20);

/// The ceiling, and the reason there has to be one is not patience.
///
/// `client_timeout_ms` is written into the `--mcp-config` **once, at spawn**, so
/// the client's own deadline cannot scale with a call it has not received yet.
/// It is therefore set from this, and every call's window has to fit under it
/// or the client gives up first and writes its own sentence instead of ours.
///
/// It is also the whole of what bounds a long call now that the question count
/// is not bounded: a twelve-question review saturates here rather than being
/// cut down to something that fits. That is the right way round — forty-five
/// minutes of reading is a long sitting, and the alternative was answering five
/// of the twelve and letting the agent guess the rest.
const ANSWER_MAX: Duration = Duration::from_secs(2700);

const DISMISSED: &str =
    "The user dismissed the question. Proceed using your best judgement.";

/// The opening of the timeout sentence, and the only part of it that is fixed.
///
/// `asking.ts::UNANSWERED` matches a reply back off disk on this prefix to tell
/// Skein's own sentence from one the user wrote, so what follows it may vary and
/// this may not. It changed once — it used to name ten minutes, which stopped
/// being true the moment the deadline started scaling — and the old wording is
/// kept over there beside this one, because a transcript already on disk carries
/// it and will go on being folded.
const TIMED_OUT_OPENING: &str = "The user did not answer in time.";

fn timed_out(waited: Duration) -> String {
    format!(
        "{TIMED_OUT_OPENING} The question stood for {} minutes. Proceed using your best \
         judgement, and say which way you went and why.",
        waited.as_secs() / 60
    )
}

/// How long *this* call waits, from what it is asking.
///
/// **Mirrored in `asking.ts::answerWindow`, and the duplication is deliberate
/// and load-bearing.** `Ask.svelte` draws a live countdown, which is real
/// information rather than decoration — it is what tells you whether to keep
/// reading or answer now — and the number it counts down to has to be the number
/// this thread gives up on. The panel has the *normalized* questions and this has
/// the raw arguments, so neither can be handed the other's answer without a
/// field on `ask:opened` and a matching read in `skein.svelte.ts`. What is shared
/// instead is the arithmetic and the counting rules, with the same table of
/// payloads asserted on both sides.
///
/// The counting mirrors `normalizeAsk`, and only the parts that change a count:
/// a `questions[]` entry needs a non-empty `question` to be drawn, the
/// single-question sugar is *appended* rather than preferred, an empty call
/// still draws one placeholder question, and an option needs a non-empty
/// `label`. Nothing is dropped for being late in the list — see `ANSWER_MAX`,
/// which is what a long call runs into instead.
fn answer_window(args: &Value) -> Duration {
    let mut drawn: Vec<&Value> = Vec::new();
    if let Some(list) = args.get("questions").and_then(|v| v.as_array()) {
        drawn.extend(list.iter().filter(|q| said(q.get("question")).is_some()));
    }
    if said(args.get("question")).is_some() {
        drawn.push(args);
    }

    let options: usize = drawn
        .iter()
        .map(|q| match q.get("options").and_then(|v| v.as_array()) {
            Some(list) => list.iter().filter(|o| said(o.get("label")).is_some()).count(),
            None => 0,
        })
        .sum();
    /* One, never zero: a call with nothing answerable in it is still drawn, as
       the "(no question given)" placeholder, and still parks a turn. */
    let questions = drawn.len().max(1);

    let want = ANSWER_BASE
        + ANSWER_PER_QUESTION * (questions as u32 - 1)
        + ANSWER_PER_OPTION * options as u32;
    want.min(ANSWER_MAX)
}

/// A field that would survive `normalizeAsk`'s trim: a string with something in
/// it. Nothing else counts, on either side of the boundary.
fn said(v: Option<&Value>) -> Option<&str> {
    v.and_then(|x| x.as_str()).map(str::trim).filter(|s| !s.is_empty())
}

/// How long the *client* must be told to wait, in milliseconds.
///
/// The parking above is worth nothing unless the CLI is still listening when
/// the answer arrives, and by default it is not. Probed against claude 2.1.232
/// with `tools/probe-ask.ts`, which parks a call and answers it late: the CLI
/// **aborts the HTTP request at 60.02s** and hands the model
/// `is_error: true, "The operation timed out."`. So a question answered at any
/// point past the first minute — which is most of them, since the whole reason
/// to ask is that somebody has to think — reached a request nobody was reading,
/// and the card went quiet having done everything right. `MCP_TOOL_TIMEOUT`
/// lifts it; the same probe with this set parked 90s, was never aborted, and
/// the answer resumed the turn in place.
///
/// The minute of headroom is the point rather than slack. Whichever side gives
/// up first writes what the model reads, and ours is the sentence worth having
/// — it says how long it waited and what to do about it, where the client's
/// says only that something timed out. The heartbeats the CLI streams
/// (`tool_progress` every 30s) do not extend its own deadline, so there is
/// nothing to send that would substitute for this.
///
/// It is `ANSWER_MAX` rather than the window a given call gets, because this is
/// written into the `--mcp-config` at spawn and a card spawned this morning has
/// no idea what it will be asked at four. So the ceiling travels and each call's
/// own clock, which is always shorter, is the one that fires. Raising the
/// client's number costs nothing: it is a bound on a request nobody is feeding,
/// and a request nobody is feeding is already killed by Bun's 300s at
/// `FEED_EVERY`.
pub fn client_timeout_ms() -> u64 {
    ANSWER_MAX.as_millis() as u64 + 60_000
}

/// The `--mcp-config` a card is spawned with: this server, addressed to it, and
/// the wall's shared browser when there is one running.
///
/// **The browser entry is here rather than anywhere else because this is the
/// only `--mcp-config` there is**, and the flag is not additive — a second one
/// replaces the first, exactly as `--append-system-prompt` does. So the same
/// argument that put the guidance and the roster paragraph behind one
/// `system_prompt` seam puts both servers behind this one function.
///
/// `shared_browser` is `None` on a chat card, which has no business reaching
/// one (`chat.md`), and `Some` on every other card — **including one spawned
/// onto a wall with no browser running**, which is the change. It used to
/// depend on whether a Chrome happened to be up at that instant, and the card
/// that lost that coin flip could not be given the tools afterwards at any
/// price. The address is a constant (`browser::address`), so the entry can be
/// written whatever the weather, and `@playwright/mcp` does not dial it until
/// the first tool call — measured, in that function's doc.
///
/// It must still agree with what `supervisor::append_prompt` was told, and that
/// is why `spawn_now` takes one reading and passes it to both rather than each
/// asking. A card handed a paragraph about tools it does not have is sink
/// `b6bfecba`, and the guard is worth keeping even now that the reading has
/// only one input — a condition with one input today is a condition with two
/// next year.
///
/// `timeout` is not a second copy of `MCP_TOOL_TIMEOUT` above, and reading it
/// as one is what let a question die at five minutes with the hard deadline set
/// to eleven. The CLI arms **two** watchdogs per `tools/call` (read out of
/// 2.1.232): the hard one that `MCP_TOOL_TIMEOUT` moves, and an *idle* one that
/// fires when a call has gone that long with neither a response nor a progress
/// notification. The idle default is per transport — 1800s for `stdio`, 300s
/// for `http`, which is what we are — and no environment variable Skein was
/// setting touched it. It is polled on a 30s interval, so the symptom is a
/// question abandoned at the first tick past five minutes with
/// `"sent no response or progress for 300s; aborting"`, on a card whose own
/// clock had another five minutes to run.
///
/// A progress notification resets it, and for a while there was nothing here to
/// send one down: this server answered POSTs and never opened a stream. So the
/// per-server `timeout` field is the fix the CLI's own message names, and it
/// raises *both* deadlines — the idle one is `max(default, timeout)` clamped to
/// the hard one — which is why one number is enough for the two of them.
///
/// It is not enough for the third, which is Bun's and is not the CLI's to
/// configure. A parked call now answers as a fed SSE stream and *does* send
/// progress notifications; see `FEED_EVERY`. Both numbers here are kept anyway
/// — they cost nothing, they are what an older build reads, and a deadline that
/// no longer fires first is still the one that fires if the feeding stops.
///
/// **There is deliberately no `alwaysLoad` here, and that is the tiering.**
///
/// Tool search is on by default in the CLI and is *not* threshold-gated when
/// `ENABLE_TOOL_SEARCH` is unset — read out of 2.1.235, where unset and `auto`
/// are different modes and only `auto` weighs the definitions against 10% of the
/// window. So a tool with nothing said about it reaches a card as a bare name
/// behind a `ToolSearch` step, with its schema withheld. For some of this server
/// that is intolerable, because everything that makes the billboard work is *in*
/// the descriptions: that reading it is free where a `send` costs the other
/// agent a turn, that a notice wants `paths` on it, that `unpost` is the half
/// nobody else can do for you.
///
/// This field used to say `true`, which exempted the whole server, and the
/// argument for it was first made of six tools and ~9KB. By 2026-08-27 it was 22
/// tools and **38,598 bytes on every spawn of every card** — a fifth of it one
/// paragraph inside `ask_user` repeated four times — with 1,402 bytes left under
/// the ceiling and a queue of tools waiting to be added. The test did what it
/// was written to do: it made that a conversation rather than a bump.
///
/// The answer was not to raise the number, and it was not to drop the flag
/// either. **The flag has a per-tool half**, which nobody here had asked the CLI
/// about: `_meta["anthropic/alwaysLoad"]` on an individual `tools/list` entry
/// exempts that tool alone, and the client takes the *union* —
/// `e.config.alwaysLoad===!0 || M._meta?.["anthropic/alwaysLoad"]===!0`, read out
/// of the 2.1.241 binary. Which is also why this field has to be *absent* rather
/// than `false`: setting it here would win over every tier below it and the
/// roster would go back to costing all of itself. See `ask::always` and
/// `ask::roster` for who is in which tier and on what argument.
///
/// **What came off with the flag was a bounded startup wait, and it was never
/// being used.** Only a server-level flag puts a config in the CLI's
/// blocking-connect bucket (`Vk(t,(f)=>f.alwaysLoad===!0)` → `L_u(!1, …)`), so
/// on paper this trades the guarantee that the tools are present when the turn-1
/// prompt is built. `tools/probe-tiers.ts` went and looked: stalling `tools/list`
/// for 6s and then 25s — five times the 5s connect cap — left the loaded tier in
/// the turn-1 prompt every time, and `MCP_CONNECTION_NONBLOCKING=0`, which would
/// force the wait back on, changed nothing observable. The wait was free here for
/// the same reason it was pointless: this is an HTTP listener on loopback that
/// `Asks::port` has already answered for by the time anything spawns.
///
/// `supervisor::append_prompt` is short because the tools it names are all in
/// the loaded tier, which is a rule `roster` states and keeps rather than a
/// coincidence. Anything moved out of that tier has to be paid for in that
/// paragraph instead, in the copy that can silently drift out of step with the
/// schema — so the trade is only worth making for tools it does not name.
pub fn mcp_config(port: u16, conversation_id: &str, shared_browser: Option<&str>) -> Value {
    let mut servers = json!({
        "skein": {
            "type": "http",
            "url": format!("http://127.0.0.1:{port}/mcp/{conversation_id}"),
            "timeout": client_timeout_ms(),
        }
    });
    if let Some(endpoint) = shared_browser {
        servers["browser"] = crate::browser::mcp_server(endpoint);
    }
    json!({ "mcpServers": servers })
}

/// A question currently on the wall, and enough about it to put it somewhere
/// else.
///
/// It was a bare `Sender<String>` for most of this file's life, which was all
/// the answer path ever needed. Going away is what wanted more: flipping the
/// switch at seven in the evening has to turn whatever is *already* parked into
/// a deferred question, and a channel on its own cannot say which card asked or
/// what it asked — so the switch would have had to leave them parked, to time
/// out against a deadline nobody was going to meet. That is precisely the loss
/// away mode exists to prevent, five minutes before it was switched on.
///
/// `ours` is the one that is not converted. See `presence::defer_parked`.
struct Parked {
    tx: Sender<String>,
    conversation_id: String,
    args: Value,
    ours: bool,
    /// The *request* behind a question Volery composed — the tool and the
    /// arguments the card gave — so that going away can file it as a deferred
    /// act rather than leaving it to expire.
    ///
    /// `None` for `ask_user`, which has no request behind it beyond the
    /// question itself. The distinction is the one `presence.rs` draws between
    /// a pile of questions and a pile of things to do: an answer to the first
    /// is handed to the agent, and an answer to the second re-enters the
    /// decision, which needs the arguments rather than the drawn question.
    act: Option<(String, Value)>,
    /// When the user last touched the panel drawing this question.
    ///
    /// Shared with the parking thread, which is the only thing that reads it:
    /// `stir_ask` writes from the IPC thread, the park reads once a tick, and
    /// the deadline it computes moves with it. See `ANSWER_HOLD`.
    ///
    /// Seeded to the moment the question opened rather than to `None`, which
    /// is what lets `held_window` need no arm for the never-touched case — a
    /// stir at t=0 buys `ANSWER_HOLD`, and the floor is longer than that.
    stirred: Arc<Mutex<Instant>>,
    /// What the user has answered so far of a sheet they have not sent. See
    /// `Held`. Shared with the parking thread for the reason `stirred` is: the
    /// thread is what has to know, at the moment the call closes some other
    /// way, whether a reply it is handed carried those answers.
    held: Arc<Mutex<Option<Held>>>,
}

/// The answers already given on a sheet that has not been sent, kept so that a
/// call which closes before the send does not take them with it.
///
/// **A deadline used to cost the whole sheet**, not just the questions nobody
/// reached. The answers live in the front end until the send, so a call with
/// five questions that expired with four answered went to the pile as five,
/// and the user re-read and re-decided four things they had already decided
/// (sink `fdc6954b`). So the panel pushes this on every answer it records
/// (`hold_ask`), and both of the ways a call closes without a send — its
/// deadline here, and the wall going away (`presence::defer_parked`) — hand
/// the agent what was decided and queue only what was not.
///
/// **Composed in TS, the way every reply to `ask_user` is**, and for the same
/// reason: `asking.ts` owns what a question *is* and Rust reads nothing out of
/// the arguments. `said` is the reply as far as it goes — numbered, headed,
/// with every unanswered slot named `not reached` rather than left out — and
/// `rest` is the unanswered questions as an ask the pile can hold, in the
/// shape `normalizeAsk` reads back. What Rust adds is the one part only it
/// knows: whether the rest was queued, and why. See `presence::defer_rest`.
#[derive(Clone, Debug, Deserialize)]
pub(crate) struct Held {
    pub said: String,
    /// `None` when every question was answered and only the send was missing.
    pub rest: Option<Value>,
}

/// Whether this reply is the hold going out — and if so, whether it left
/// anything for the pile. `None` for every reply that is not.
///
/// See `park_and_stream` for why a prefix is the right test: it is this
/// thread's own string, not a second wording of it.
fn carried(held: Option<&Held>, answer: &str) -> Option<bool> {
    held.filter(|h| answer.starts_with(h.said.as_str())).map(|h| h.rest.is_some())
}

impl Held {
    /// Typed by a person, and read by an agent — the same scrub every other
    /// text bound for a card passes through (`crate::clean`).
    fn scrubbed(mut self) -> Self {
        if let std::borrow::Cow::Owned(clean) = crate::clean::scrub(&self.said) {
            self.said = clean;
        }
        if let Some(rest) = self.rest.as_mut() {
            scrub_json(rest);
        }
        self
    }
}

/// How much time touching the panel buys, from the moment it is touched.
///
/// Mirrored in `asking.ts` as `ANSWER_HOLD`, under the same bargain as the
/// four constants above and for a sharper reason: the countdown drawn in the
/// panel and the deadline this thread gives up on have to be the same number,
/// or the instrument is lying in the one direction that loses work.
///
/// "we need to improve the ask tool to not decrease time when i'm litterally
/// active and typing in it, it's stressful and work losing for no reason" —
/// sink `7264177f`. Note what could *not* be done about that: the panel cannot
/// simply pause its own clock, because this thread would go on counting. The
/// deadline itself has to move.
const ANSWER_HOLD: Duration = Duration::from_secs(300);

/// The deadline a call actually has, given when its panel was last touched.
///
/// `since_open` is measured from the same origin the window is. Clamped to
/// `ANSWER_MAX` at the top because that ceiling is not patience — it is the
/// client's own deadline, written into the `--mcp-config` at spawn, and
/// nothing on this side may promise past it.
fn held_window(base: Duration, since_open: Duration) -> Duration {
    base.max(since_open + ANSWER_HOLD).min(ANSWER_MAX)
}

#[derive(Default)]
pub struct Asks {
    port: Mutex<u16>,
    pending: Mutex<HashMap<String, Parked>>,
}

#[derive(Clone, Serialize)]
struct AskOpened {
    conversation_id: String,
    ask_id: String,
    /// Whether Skein composed this question rather than the agent asking it.
    ///
    /// One bit, and it exists to keep the transcript honest rather than to
    /// change how the panel draws. An agent's `ask_user` is half of an exchange:
    /// the call is in the transcript, your reply is drawn under it, and
    /// `history.ts` finds both again off disk because the call's tool name is
    /// `SKEIN_ASK_TOOL`. A question *Skein* put up — `close` wanting approval
    /// for a card the caller did not open — has no such call. The agent's
    /// transcript holds a `close` tool call and its result, and the result is
    /// composed here from the answer rather than being the answer. So drawing
    /// your click as a line of speech would put a line on a live card that
    /// vanishes the moment it is restored, which is precisely the seam
    /// `history.ts` exists to avoid. The wall reads this and stays quiet; the
    /// tool result is the record, and it is the same one either way.
    ours: bool,
    /// The tool call's arguments, exactly as they arrived.
    ///
    /// Rust decides nothing about what a question *is* — `asking.ts` owns the
    /// vocabulary and normalizes on every read, the same bargain
    /// `widget.config_json` and `ambience_profile.layers_json` strike. It earns
    /// its keep the same way, too: `questions` was added here without this
    /// struct changing, and the next field will be free as well. What arrives
    /// is whatever a model composed, so nothing may depend on its shape —
    /// `normalizeAsk` is written to degrade rather than refuse, because a
    /// payload we decline to draw is a card parked with no way to unpark it.
    ask: Value,
}

#[derive(Clone, Serialize)]
struct AskClosed {
    ask_id: String,
    answered: bool,
    /// The question did not go unanswered — it went into the pile.
    ///
    /// A third outcome rather than a shade of `answered`, because the panel
    /// does something different for each. An ask that closed with nobody
    /// answering gets `NO_ANSWER_NOTE` written into the card, since the agent
    /// went on regardless and a panel that showed a question and then nothing
    /// would leave that unaccounted for. A *deferred* one needs no such note:
    /// the tool result says it was queued, in better words than a note has, and
    /// unlike a note it says them in the transcript a restart can reproduce.
    /// That is the same bargain `ours` strikes one field up.
    deferred: bool,
    /// The reply, when it carried answers the user gave without sending them
    /// — the call closed on a sheet partway through (`Held`).
    ///
    /// The panel draws it as your answer, because it is: nothing else will,
    /// since `answerAsk` never ran, and off disk the same text is the tool
    /// result `answerNote` folds into the same line. `None` for everything
    /// else, including an answer that *was* sent, which the panel drew itself.
    said: Option<String>,
}

impl Asks {
    pub fn port(&self) -> u16 {
        *self.port.lock().unwrap()
    }
    pub fn set_port(&self, port: u16) {
        *self.port.lock().unwrap() = port;
    }
}

/// Take every agent-asked question off the wall, so somewhere else can hold it.
///
/// Written for `presence::defer_parked` and deliberately knowing nothing about
/// why: this file stays the transport, and what a question *means* once it is
/// no longer parked is away mode's business. What is kept here is the rule that
/// is about parking — **a question carrying a `Settle` is not drained**, since
/// the settle lives on the parked thread and is the only thing that can
/// perform it. `presence.rs` has the argument for why that is the right
/// boundary and not merely the convenient one.
///
/// Removed from `pending` as they are taken, so the answer path and this cannot
/// both claim one; the caller is then the only thing holding the channel.
pub(crate) struct Taken {
    pub conversation_id: String,
    /// The question as it was drawn.
    pub question: Value,
    /// The request behind it, for one Volery composed. See `Parked::act`.
    pub act: Option<(String, Value)>,
    /// What the user had already answered of it, if anything. See `Held`.
    pub held: Option<Held>,
    pub tx: Sender<String>,
}

pub(crate) fn take_parked_questions(asks: &Asks) -> Vec<Taken> {
    let mut pending = asks.pending.lock().unwrap();
    /* Everything an agent asked, and everything Volery asked that carries a
       request it can be re-entered from. What is left behind is the third case
       — a question Volery composed whose caller is gone — and there is nothing
       to file it under. */
    let ids: Vec<String> = pending
        .iter()
        .filter(|(_, p)| !p.ours || p.act.is_some())
        .map(|(id, _)| id.clone())
        .collect();
    ids.into_iter()
        .filter_map(|id| pending.remove(&id))
        .map(|p| Taken {
            conversation_id: p.conversation_id,
            question: p.args,
            act: p.act,
            held: p.held.lock().unwrap().clone(),
            tx: p.tx,
        })
        .collect()
}

/// The user is working on this question, so move its deadline out.
///
/// The whole of the Rust half of sink `7264177f`. It writes one `Instant` and
/// takes no decision: `held_window` is where the rule lives, and the parking
/// thread applies it on its own next tick, so this cannot block on anything and
/// does not need to be `async`.
///
/// Returning `Err` for a question that is no longer parked is deliberate even
/// though the caller ignores it — `answer_ask` next door says the same thing
/// the same way, and a command that silently succeeded at doing nothing is one
/// the control surface could not test.
#[tauri::command]
pub fn stir_ask(asks: State<'_, Asks>, ask_id: String) -> Result<(), String> {
    let pending = asks.pending.lock().unwrap();
    let parked = pending.get(&ask_id).ok_or("that question is no longer waiting")?;
    *parked.stirred.lock().unwrap() = Instant::now();
    Ok(())
}

/// The user has answered some of this sheet: keep it, in case the call closes
/// before the send.
///
/// Called on every answer the panel records, with the whole of what has been
/// said so far rather than a delta — so a lost call costs nothing but being one
/// answer behind, and the last one to land is the truth. `None` clears it.
/// Takes no decision and blocks on nothing, like `stir_ask` beside it; what a
/// held sheet *means* is decided when the call closes. See `Held`.
#[tauri::command]
pub fn hold_ask(asks: State<'_, Asks>, ask_id: String, held: Option<Held>) -> Result<(), String> {
    let pending = asks.pending.lock().unwrap();
    let parked = pending.get(&ask_id).ok_or("that question is no longer waiting")?;
    *parked.held.lock().unwrap() = held.map(Held::scrubbed);
    Ok(())
}

/// Hand the UI's answer back to the parked HTTP request.
#[tauri::command]
pub fn answer_ask(asks: State<'_, Asks>, ask_id: String, answer: String) -> Result<(), String> {
    let parked = asks
        .pending
        .lock()
        .unwrap()
        .remove(&ask_id)
        .ok_or("that question is no longer waiting")?;
    parked
        .tx
        .send(answer)
        .map_err(|_| "the asking turn has gone".to_string())
}

/// Answer a parked question from another wall, over the flyway.
///
/// `answer_ask`'s channel, so the card cannot tell a click in this wall's dock
/// from one made on the other machine — the panel here comes down the same way,
/// off the parking thread's own `ask:closed`. With two refusals in front of it:
///
/// - **the card must be the one the question is parked on.** The ask id is a
///   uuid and cannot collide, so this is not a guard against chance; it is the
///   far wall's own claim about which card it was looking at, checked rather
///   than believed.
/// - **only `ask_user` travels.** A question Volery composed — closing a card,
///   taking a notice down, removing a path — has an act behind it (`ours`,
///   `act`), and an answer to it *does* the thing. Whether those travel, and
///   with what in front of the person answering, is decided (sink `7207a6d9`:
///   the machine named, the path as that machine resolves it, what is there)
///   and not built; until it is, the answer is refused here, on the machine
///   the act would happen on, rather than trusted to the far wall's drawing.
pub(crate) fn answer_from_afar(app: &AppHandle, card: &str, ask_id: &str, answer: &str) -> Result<(), String> {
    let asks = app.try_state::<Asks>().ok_or("this wall's questions are not up yet")?;
    let parked = {
        let mut pending = asks.pending.lock().unwrap();
        match pending.get(ask_id) {
            None => {
                return Err("that question is no longer waiting — it was answered on its own wall, or \
                            its time ran out"
                    .into())
            }
            Some(p) if p.conversation_id != card => {
                return Err("that question belongs to another card on this wall".into())
            }
            Some(p) if p.ours || p.act.is_some() => {
                return Err("that question is this wall's own — about closing or removing something \
                            here — and is answered on the machine it is about"
                    .into())
            }
            Some(_) => pending.remove(ask_id).ok_or("that question is no longer waiting")?,
        }
    };
    parked
        .tx
        .send(crate::clean::scrub(answer).into_owned())
        .map_err(|_| "the asking turn has gone".to_string())
}

/// A design the user can look at instead of imagine.
///
/// Skein draws this in an isolated frame — see `asking.ts::previewDoc` for what
/// contains it. The description is doing real work: the model has spent its
/// whole life describing layouts in prose to a terminal, and left to itself will
/// keep doing that beside an empty `preview` field.
///
/// **Written out once and pointed at three times, because `ask_user` was a
/// fifth of the whole roster and most of it was this paragraph repeated.** The
/// field appears at four places in one payload — beside `question`, beside each
/// `option`, and both again inside `questions[]` — and `option_schema` is
/// itself emitted twice, so the full text was reaching the model four times per
/// spawn of every card at 1,354 bytes a copy. Measured 2026-08-27: 5,416 bytes,
/// 14% of `tools/list`, spent saying one thing four times.
///
/// `full` is the one canonical copy and it sits on the *top-level* `preview` —
/// the simplest form of the call, and the one place a caller reads before it
/// has decided whether it wants `questions[]` at all. The other three name it
/// rather than restating it. The pointer is worth more than a truncation would
/// be: the constraints are what stop an agent reaching for a framework or a
/// font, and a reader that is told where they are can go and get them, where a
/// reader given half of them does not know a half is missing.
///
/// **And the paragraph was cut again when `file` arrived**, which is the budget
/// in `the_loaded_tier_is_what_every_turn_pays_for` doing exactly its job: a
/// second way to show something put the loaded tier over its ceiling, and the
/// reclamation came out of what the two fields were *both* saying. "Shown side
/// by side, full size, instead of described" is one sentence about the gallery
/// and it is now in the tool's own description, said once; what is left here is
/// only what is true of a composed design and of nothing else — the sealed
/// frame, the tokens, the viewport. `file_schema` is the same shape with the
/// same split. The general lesson, for the next field that wants a paragraph:
/// **when two options are two answers to one question, the shared half belongs
/// to the question.**
fn preview_schema(full: bool) -> Value {
    if !full {
        return json!({
            "type": "object",
            "description":
                "Optional. A design, same shape as the top-level `preview` — see \
                 that one for what it renders in, what is forbidden, and the \
                 viewport to compose for.",
            "properties": {
                "html": { "type": "string", "description": "The body markup." },
                "css": { "type": "string", "description": "A stylesheet." },
                "js": {
                    "type": "string",
                    "description":
                        "Script, only where the decision turns on interaction. \
                         It does not run until the user asks it to."
                }
            },
            "required": ["html"]
        });
    }
    json!({
        "type": "object",
        "description":
            "Optional. A design you compose here, as a small self-contained web \
             page. Reach for it when the layout, card, colour treatment or chart \
             does not exist yet; for one that does, use `file`. Rendered in a \
             sealed frame: no network, no imports, no frameworks, no external \
             fonts or images (inline SVG and data: URIs are fine). Skein's own \
             design tokens are defined — var(--paper), var(--ink), var(--surface), \
             var(--edge), var(--body) and the rest — and are what to build in. \
             Compose for a 1280x800 viewport; it is scaled down to fit.",
        "properties": {
            "html": {
                "type": "string",
                "description":
                    "The body markup. Required for a preview to be shown at all."
            },
            "css": {
                "type": "string",
                "description":
                    "A stylesheet for it. Hover, focus and transition all work, \
                     so most of what a design turns on needs no script."
            },
            "js": {
                "type": "string",
                "description":
                    "Script, only where the decision genuinely turns on \
                     interaction — a menu opening, a stepper advancing. It does \
                     not run until the user asks it to, and never on a chat \
                     conversation, so the design must still read correctly \
                     without it. A design whose markup is an empty skeleton its \
                     script fills in draws nothing at all until somebody runs \
                     it: compose in `html` and `css`, and keep this for what a \
                     static rendering genuinely cannot show."
            }
        },
        "required": ["html"]
    })
}

/// A file that already exists, as against a design being composed.
///
/// `preview` is live HTML and is the right tool for a layout that does not
/// exist yet. It is the wrong tool for a screenshot, a render, a PDF, a
/// spreadsheet or a page of notes — there is nothing to compose, the thing is
/// already a file, and an agent holding one has until now had to describe it or
/// `pin` it to the wall and ask a question that pointed at it sideways. The
/// wall is for what outlives the question; this is for the question.
///
/// **Nothing here knows what a file format is, and that is the arrangement.**
/// The only thing this validates is that the path names a file; which of the
/// readings it gets — image, video, PDF, Word, workbook, markdown, source — is
/// decided by `finding.ts::drawnAs`, which is the one table the viewer already
/// reads from, and it is drawn by the viewer's own components. A second
/// opinion held over here would be a second place to be wrong about a format,
/// which is the bargain `find::read_doc` already strikes and says so.
///
/// Written out once and pointed at three times, for the reason stated over
/// `preview_schema`: the field appears at four sites in one payload and
/// `option_schema` is itself emitted twice, so a full copy at each is one
/// paragraph reaching the model four times per spawn of every card.
fn file_schema(full: bool) -> Value {
    if !full {
        return json!({
            "type": "string",
            "description":
                "Optional. A file, same rules as the top-level `file`."
        });
    }
    json!({
        "type": "string",
        "description":
            "Optional. A file that already exists: a path, absolute or relative \
             to this conversation's working directory. It opens in the app's own \
             viewer, so anything that viewer draws works — image, video, PDF, \
             Word, spreadsheet, markdown rendered as a document, any source file. \
             Reach for it whenever what you want decided already exists: a \
             screenshot of what you changed, a render, a frame, a chart you \
             plotted, the report you just generated, the config you are proposing \
             to replace. Not `preview`, which is live HTML for a design that does \
             not exist yet; and not `pin`, which puts a picture on the wall and \
             leaves it there, where this one belongs to the question. A path that \
             names no file refuses the whole call rather than asking with a hole \
             in it, so write the file first."
    })
}

/// One question's shape, shared by the `questions` array and reused for the
/// single-question sugar so the two cannot drift apart.
fn option_schema() -> Value {
    json!({
        "type": "array",
        /* Terse on purpose, and the terseness is the design rather than a
           saving. This is the loaded tier — every byte here is paid on every
           spawn of every card — while `undescribed_note` costs nothing until
           it fires. So the schema carries only what has to shape the call
           before it is written, and the refusal carries the instruction. */
        "description":
            "Preset answers, your recommendation first. Give each a `detail`; \
             options that are all bare labels are refused.",
        "items": {
            "type": "object",
            "properties": {
                "label":  {
                    "type": "string",
                    "description": "The choice itself, in a few words."
                },
                "detail": {
                    "type": "string",
                    "description":
                        "One short line on the cost or risk of picking this, not \
                         a restatement of the label. Drawn on a button, so \
                         reasoning goes in the question."
                },
                /* Terse, and this is the copy that would have cost most: an
                   option's preview is the flagship use — several designs side
                   by side — but `option_schema` is emitted at both levels, so
                   the full text here is paid for twice. */
                "preview": preview_schema(false),
                "file": file_schema(false)
            },
            "required": ["label"]
        }
    })
}

fn tool_schema() -> Value {
    json!({
        "name": "ask_user",
        "description":
            "Ask the human a question and wait for their answer. Use this whenever you \
             need a decision only they can make — a choice between approaches, a \
             confirmation, a missing detail. Prefer it over ending your turn with a \
             question, because this keeps the turn open and resumes as soon as they \
             answer. Supply `options` when the answer is a choice; they can then reply \
             with one click.\n\n\
             Say what is at stake and which way you would go: they have not read \
             the code and you have.\n\n\
             When you have more than one decision outstanding, put each in its own \
             entry of `questions` rather than fusing them into one. They are asked one \
             at a time and answered separately, and there is no limit on how many a \
             call may carry — a dozen decisions after a round of worker reports is a \
             fine use of one call. Fusing two decisions forces the options to be \
             combinations of both — which is longer to read and, worse, silently \
             leaves out the combinations you did not think to list.\n\n\
             When the decision is a visual one, do not describe it — show it. \
             `preview` is a design you compose here; `file` is one that already \
             exists on disk. Put one on each option to compare, or one on the \
             question to approve, and they are drawn side by side, full size, for \
             the user to look at and pick from — both kinds in the same gallery. \
             This client has a real display; a layout written out in prose is a \
             layout being chosen from memory.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "questions": {
                    "type": "array",
                    "description":
                        "The decisions you need made, one entry each, in the order you \
                         want them asked. Use this whenever there is more than one.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "header": {
                                "type": "string",
                                "description":
                                    "Two or three words naming this decision — 'widget \
                                     shape', 'notifications'. Shown while the others \
                                     are being answered."
                            },
                            "question": {
                                "type": "string",
                                "description":
                                    "This one decision, in one or two sentences. \
                                     Markdown is fine."
                            },
                            "options": option_schema(),
                            "preview": preview_schema(false),
                            "file": file_schema(false)
                        },
                        "required": ["question"]
                    }
                },
                "question": {
                    "type": "string",
                    "description":
                        "A single question, in one or two sentences — the short form \
                         for when there is only one decision. Markdown is fine."
                },
                "options": option_schema(),
                /* The one full copy. Top level rather than one of the nested
                   sites because it is the form a caller reads first, and the
                   three pointers name it by this position. */
                "preview": preview_schema(true),
                "file": file_schema(true)
            }
        }
    })
}

/// How often a parked call is fed while it waits, and the reason there is a
/// third clock in this file at all.
///
/// Two deadlines were already known about and both are the CLI's: the hard one
/// `MCP_TOOL_TIMEOUT` moves, and the idle one the per-server `timeout` field
/// moves. Reported again 2026-08-20 — a question drawn, an option clicked, and
/// the agent reading `is_error: true, "The operation timed out."` at 286s, on a
/// card whose own clock had another five minutes to run and with both of those
/// numbers already set to eleven.
///
/// That sentence is not in the CLI's JavaScript. It is in the **Bun** runtime
/// strings inside `claude.exe`, which is a Bun single-file executable, and it is
/// what Bun's `fetch` says when its own default timeout fires. Probed with
/// `tools/probe-park.ts`, which parks two requests and speaks on only one of
/// them: the silent one is aborted at **300.57s** with exactly that message and
/// exactly that name, and the one fed every 20s ran to 700s and delivered its
/// answer. So the clock is Bun's, it is reset by bytes rather than fixed to the
/// request, and **nothing the CLI parses reaches it** — not the env var, not the
/// config field, not a flag; the number is inside the interpreter its client is
/// compiled into.
///
/// Which leaves one move: say something. A parked `tools/call` is answered as
/// `text/event-stream` — headers at once, a keep-alive every `FEED_EVERY`, the
/// result as the last event — because a stream is the one shape of reply a
/// ten-minute park can survive. MCP allows exactly this, and the client's own
/// POST carries `Accept: application/json, text/event-stream`, so it is the
/// protocol's answer to a long call rather than a trick played on it.
///
/// 25s sits comfortably under all three of the things it has to: a tenth of
/// Bun's clock, less than the 30s tick the CLI's idle watchdog is polled on, and
/// the longest a question now goes on being drawn after the agent has abandoned
/// it — because a write that fails is a client that hung up, which is the one
/// thing the blocking park could never see.
const FEED_EVERY: Duration = Duration::from_secs(25);

/// How many files one call may attach.
///
/// The question count is deliberately unbounded — twelve decisions after a
/// round of worker reports is the shape this tool encourages, and every one of
/// them could name a file. Each attachment is a read the panel makes through
/// `find::read_file_doc`, which carries up to 24 MB base64 apiece. Twenty-four
/// is past anything a person reads in a sitting and well under anything that
/// matters.
const MAX_FILES: usize = 24;

/// Resolve every file a call attached and rewrite it as the pair the viewer
/// reads: a root and a path inside it.
///
/// **Before anything else the `ask_user` arm does**, and the two reasons are the
/// two things that happen after it. The question is drawn from these arguments,
/// so a path that names nothing is a panel with a hole in it and nothing to say
/// why; and away mode stores them verbatim in `deferred_ask`, so a relative path
/// is one whose meaning depends on a working directory nobody will remember in
/// the morning.
///
/// **The pair is `(parent directory, file name)` rather than the project root.**
/// Every read in `find.rs` goes through `safe_join`, which refuses a path that
/// climbs out of its root — so handing it the card's working tree would refuse
/// the screenshot in `%TEMP%` that is the commonest thing an agent has to show.
/// Rooting each file at its own parent keeps the containment exactly as strong
/// (one named file, reached by its own name) and costs the agent nothing.
///
/// Nothing here reads the file or cares what is in it. The reading is
/// `finding.ts::drawnAs`'s, which is the viewer's own one table, and the
/// drawing is `Leaf.svelte`'s. See `file_schema`.
///
/// A path that names no file **refuses the whole call**, which is `pin`'s
/// bargain rather than `preview`'s. A design built by its script is still a
/// question worth asking with a note attached (`previewAside`); a question
/// whose file is missing is a question about nothing, and the agent learns what
/// is wrong in a second instead of ten minutes later.
fn attach_files(app: &AppHandle, caller: &str, mut args: Value) -> Result<Value, String> {
    /* Decided by what kind of card asked, never by the payload — the rule
       `spawn_conversation` follows when it reads `kind_of` off the store rather
       than taking a capability as an argument, and the same one `Ask.svelte`
       follows for whether a design may run its script.

       A chat card spawns `--tools WebSearch,WebFetch` with no bypass: no Read,
       no Write, no Bash. So it cannot *make* a file to show you, and the only
       paths it could name are ones it did not write — which is a capability
       with no honest use and one dishonest one, your own `.env` drawn legibly
       on your own screen under a question about it. The content never reaches
       the model either way, so this is not the exfiltration it looks like; it
       is a chat card being given a reach into the disk that every other thing
       about that card kind says it does not have. Cheap to close and nothing
       is lost by closing it. */
    if let Some(store) = app.try_state::<crate::store::Store>() {
        if crate::store::kind_of(&store, caller) == "chat" && has_file(&args) {
            return Err("this is a chat conversation, which is spawned with no access to \
                        this machine at all — so it may not attach a file to a \
                        question. Ask in words, or use `preview` to compose what you \
                        mean."
                .to_string());
        }
    }

    let mut n = 0usize;
    attach_at(app, caller, &mut args, &mut n)?;
    attach_each(app, caller, args.get_mut("options"), &mut n)?;
    if let Some(questions) = args.get_mut("questions").and_then(Value::as_array_mut) {
        for q in questions {
            attach_at(app, caller, q, &mut n)?;
            attach_each(app, caller, q.get_mut("options"), &mut n)?;
        }
    }
    Ok(args)
}

/// Whether a call attaches anything at all, for the one gate that is about the
/// *caller* rather than about the path. Cheaper than walking it twice and
/// clearer than threading a flag through the walk that does the work.
fn has_file(args: &Value) -> bool {
    fn at(v: &Value) -> bool {
        v.get("file").is_some_and(|f| !f.is_null())
    }
    fn any(v: Option<&Value>) -> bool {
        v.and_then(Value::as_array).is_some_and(|l| l.iter().any(at))
    }
    if at(args) || any(args.get("options")) {
        return true;
    }
    args.get("questions")
        .and_then(Value::as_array)
        .is_some_and(|qs| qs.iter().any(|q| at(q) || any(q.get("options"))))
}

fn attach_each(
    app: &AppHandle,
    caller: &str,
    slot: Option<&mut Value>,
    n: &mut usize,
) -> Result<(), String> {
    let Some(list) = slot.and_then(Value::as_array_mut) else {
        return Ok(());
    };
    for option in list {
        attach_at(app, caller, option, n)?;
    }
    Ok(())
}

/// One site that may carry a `file`: the call itself, a question, an option.
fn attach_at(
    app: &AppHandle,
    caller: &str,
    site: &mut Value,
    n: &mut usize,
) -> Result<(), String> {
    let Some(slot) = site.get_mut("file") else {
        return Ok(());
    };

    /* **Both shapes go through the same checks, and that is the point.** This
       guard used to return early on an object carrying `root`, on the stated
       belief that `root` is "a key nothing but this function writes" — which
       is not true of anything here: `slot` is a subtree of the agent's own
       arguments, and the function already accepts `{"path": ...}` on purpose,
       so one more key beside it is no reach at all. The early return skipped
       `resolve`'s existence check *and* the counter, which means a forged pair
       defeated the one promise this function makes (a bad path refuses the
       call rather than asking with a hole in it) and made `MAX_FILES`
       unbounded besides. Found in review.

       So a pair is simply joined back up and re-checked. Idempotence falls out
       of that rather than being asserted: a pair we wrote resolves to the same
       file and is rewritten to the same pair, and one we did not is checked
       like anything else. */
    let want = if let Some(root) = slot.get("root").and_then(Value::as_str) {
        match slot.get("path").and_then(Value::as_str) {
            Some(name) => Some(
                std::path::Path::new(root)
                    .join(name)
                    .to_string_lossy()
                    .to_string(),
            ),
            None => {
                return Err("`file` carried a `root` with no `path`, which names a \
                            directory rather than a file."
                    .to_string())
            }
        }
    } else {
        /* A string is what the schema asks for; an object with a `path` is the
           shape an agent reaches for anyway, having just read `pin`'s. Both
           mean the same thing and refusing one of them would teach nothing. */
        slot
            .as_str()
            .or_else(|| slot.get("path").and_then(Value::as_str))
            .map(|s| s.trim().to_string())
    };

    let Some(want) = want else {
        if slot.is_null() {
            return Ok(());
        }
        return Err("`file` must be the path to a file on disk, as a string. It carried \
                    something else."
            .to_string());
    };
    /* Empty is an agent writing the field out and leaving it blank, which means
       no file rather than a broken one. */
    if want.is_empty() {
        *slot = Value::Null;
        return Ok(());
    }

    *n += 1;
    if *n > MAX_FILES {
        return Err(format!(
            "this call attached more than {MAX_FILES} files, which is the limit — a sheet \
             that long is past what anyone reads in a sitting. Ask about the ones that \
             matter."
        ));
    }

    let full = crate::pin::resolve(app, caller, &want, "Write the file first, then ask about it")?;
    /* Both halves have to exist for the viewer's join to land on the file, and
       a file always has both — this is belt and braces over `resolve`, which has
       already established it is a file. */
    let (Some(root), Some(name)) = (full.parent(), full.file_name()) else {
        return Err(format!("{} is not a file this viewer can open", full.display()));
    };
    *slot = json!({
        "root": root.to_string_lossy(),
        "path": name.to_string_lossy(),
    });
    Ok(())
}

/// Register a question and put it in front of the user. Returns the id it was
/// filed under and the channel a click comes back on.
fn open_ask(
    app: &AppHandle,
    asks: &Asks,
    conversation_id: &str,
    args: &Value,
    ours: bool,
    act: Option<(String, Value)>,
) -> (String, Receiver<String>, Arc<Mutex<Instant>>, Arc<Mutex<Option<Held>>>) {
    let ask_id = crate::store::uuid_v4();
    let (tx, rx) = mpsc::channel::<String>();
    let stirred = Arc::new(Mutex::new(Instant::now()));
    let held = Arc::new(Mutex::new(None));
    asks.pending.lock().unwrap().insert(
        ask_id.clone(),
        Parked {
            tx,
            conversation_id: conversation_id.to_string(),
            args: args.clone(),
            ours,
            act,
            stirred: Arc::clone(&stirred),
            held: Arc::clone(&held),
        },
    );

    let _ = app.emit(
        "ask:opened",
        AskOpened {
            conversation_id: conversation_id.to_string(),
            ask_id: ask_id.clone(),
            ask: args.clone(),
            ours,
        },
    );

    (ask_id, rx, stirred, held)
}

/// One SSE event carrying one JSON-RPC message.
fn sse(message: &Value) -> String {
    format!("event: message\ndata: {message}\n\n")
}

/// Write one chunk of a chunked body and put it on the wire.
///
/// The flush is the entire reason this is written by hand rather than handed to
/// `Response::new` with an unknown length. tiny_http would happily stream the
/// body — `io::copy` into a `chunked_transfer::Encoder` — but the socket under
/// it is wrapped in `BufWriter::with_capacity(1024, …)` and the encoder is built
/// without `with_flush_after_write`. A 90-byte keep-alive would therefore sit in
/// that buffer waiting for a tenth of a kilobyte of company, while the clock it
/// exists to reset ran out. A keep-alive that is not on the wire is not one.
fn chunk(w: &mut dyn Write, body: &str) -> std::io::Result<()> {
    write!(w, "{:x}\r\n{body}\r\n", body.len())?;
    w.flush()
}

/// Park a call on an answer that comes from somewhere other than a person —
/// another wall, over the flyway — and stream keep-alives while it waits.
///
/// `park_and_stream` is the shape for a question: it draws a panel, scales its
/// deadline to the reading, and can queue the question when nobody comes. None
/// of that applies to a remote spawn, which has no panel, no reader and a
/// deadline set by the protocol (`fleet::ASK_TTL_MS`); what it shares is the
/// part that took three sittings to get right — the stream rather than a held
/// body, written by hand so the bytes reach the wire, with a progress note per
/// `FEED_EVERY` so neither the CLI's idle watchdog nor Bun's fetch clock gives
/// up first. So that part is reused and the rest is not.
///
/// The receiver's sender is held by the flyway; when this gives up, `rx` is
/// dropped, and an answer that arrives afterwards finds nobody listening and
/// is delivered to the card as a message instead (`link::Link::tell`).
pub(crate) fn park_for_answer(
    id: &Value,
    progress: Option<Value>,
    req: tiny_http::Request,
    rx: std::sync::mpsc::Receiver<String>,
    window: Duration,
    waiting: &str,
    on_timeout: String,
) {
    let mut w = req.into_writer();
    let head = "HTTP/1.1 200 OK\r\n\
                Content-Type: text/event-stream\r\n\
                Cache-Control: no-cache\r\n\
                Transfer-Encoding: chunked\r\n\
                \r\n";
    if w.write_all(head.as_bytes()).and_then(|()| chunk(&mut *w, ": parked\n\n")).is_err() {
        return;
    }
    let started = Instant::now();
    let mut fed: u64 = 0;
    let reply = loop {
        let left = window.saturating_sub(started.elapsed());
        if left.is_zero() {
            break on_timeout;
        }
        match rx.recv_timeout(FEED_EVERY.min(left)) {
            Ok(text) => break text,
            Err(RecvTimeoutError::Disconnected) => break on_timeout,
            Err(RecvTimeoutError::Timeout) => {
                if started.elapsed() >= window {
                    break on_timeout;
                }
                fed += 1;
                let note = match &progress {
                    Some(token) => sse(&json!({
                        "jsonrpc": "2.0",
                        "method": "notifications/progress",
                        "params": { "progressToken": token, "progress": fed, "message": waiting }
                    })),
                    None => ": waiting\n\n".to_string(),
                };
                if chunk(&mut *w, &note).is_err() {
                    return;
                }
            }
        }
    };
    let _ = chunk(
        &mut *w,
        &sse(&json!({
            "jsonrpc": "2.0", "id": id,
            "result": { "content": [{ "type": "text", "text": reply }] }
        })),
    )
    .and_then(|()| w.write_all(b"0\r\n\r\n"))
    .and_then(|()| w.flush());
}

/// What the answer *means*, for a parked call that is not `ask_user`.
///
/// `ask_user` needs none of this: the reply to the agent is the answer, word for
/// word, because the agent asked the question and the words are the whole of
/// what it wanted. `close` is the other shape — Skein composed the question, so
/// the answer is a decision rather than a message, and something has to turn it
/// into the sentence the tool call returns *and do the closing on the way*.
/// That belongs to the tool, not to the transport, which is why this is a
/// closure the caller supplies rather than a second arm in here.
///
/// `None` for the answer is the question never having been answered — the ten
/// minutes ran out, or the card was dismissed. Passed rather than the sentence
/// itself, so nothing downstream has to match on Skein's own prose to find out
/// whether a person actually decided anything.
pub(crate) type Settle = Box<dyn FnOnce(&AppHandle, Option<&str>) -> String + Send>;

/// Park a question on its own request until the UI answers, speaking every
/// `FEED_EVERY` so the client is still listening when it does.
/// What running out of time means, now that it no longer means "decide it
/// yourself".
///
/// **A deadline passing is not an answer**, and for most of this file's life it
/// was treated as one: the agent read `timed_out` — "proceed using your best
/// judgement" — and did. That is the same conflation `SKIPPED` was split out of
/// one layer up, arriving by a different route. The user not getting to a
/// question in forty-five minutes says nothing whatever about what she would
/// have decided, and the cost of reading it as consent is asymmetric in the
/// direction that pushes, deploys and deletes.
///
/// So the ordinary case now does what away mode already did with a question it
/// could not put to anybody: it **queues** it. The question survives into the
/// pile, the user can answer it whenever she gets there, the answer reaches the
/// card as a message, and the agent is told all of that in the same words away
/// mode uses — because what happened to the question is the same thing. Sink
/// `7264177f`, and Lyss: "when the timer expires on a question, it shouldn't
/// mean 'no answer in time, do it according to your best judgement', it should
/// mean deferred, same as if I were away".
///
/// **Two cases keep the old behaviour, and both are Volery's own questions
/// rather than an agent's.** The boundary is the one `defer_parked` already
/// draws for the same reason:
///
///  - A question carrying a `Settle` — `close`, `unpost`, the `remove`
///    hand-off. The settle lives on *this* thread and is the only thing that
///    can perform it, so the question cannot be moved off into the pile at all.
///    Its unanswered behaviour is the conservative one (`decide(app, None)`,
///    below), which is the right answer to a deadline anyway: nothing happens.
///  - A question carrying an `act` but no settle — `smith`, `docket`: writes to
///    somebody else's service. `defer_act` is where one of those goes when the
///    wall is away, and re-entering a write to an external service after an
///    unattended forty-five minutes is a decision this function is not in a
///    position to make. It times out, as it did.
///
/// Which leaves `ask_user` — the whole of what Lyss meant, and the only kind of
/// question that is purely information flowing back to an agent.
fn expired(
    app: &AppHandle,
    conversation_id: &str,
    args: &Value,
    settle: &Option<Settle>,
    act: &Option<(String, Value)>,
    window: Duration,
    held: Option<Held>,
) -> String {
    if settle.is_some() || act.is_some() {
        return timed_out(window);
    }
    /* A sheet the user was partway through. What they decided goes to the
       agent now and only what they did not reach goes to the pile — the whole
       of sink `fdc6954b`. The noise below is the same argument with a
       different sentence, since "a question was queued" would undersell that
       answers were sent. */
    if let Some(held) = held {
        let queued = held.rest.is_some();
        let reply = crate::presence::defer_rest(
            app,
            conversation_id,
            &held.said,
            held.rest.as_ref(),
            crate::presence::Queued::Unattended,
        );
        if !crate::presence::away(app) {
            let (mark, detail) = if queued {
                (
                    "a question timed out partway through and the rest was queued for you",
                    "the answers you had given were sent; nothing else was decided — \
                     read the rest from the pile (space then q)",
                )
            } else {
                (
                    "a question timed out with every answer given but not sent",
                    "your answers were sent as they stood, and the agent was told you \
                     had not sent them yourself",
                )
            };
            crate::chronicle::note(app, None, "volery", "note", mark, detail);
        }
        return reply;
    }
    /* A card's notice that asked to be waited on. Same move as a question —
       queued rather than expired — into the queue a notice belongs in, which
       is already the thing that rings, so there is no chronicle row to add. */
    if crate::notice::is_notice(args) {
        let text = args["notice"]["text"].as_str().unwrap_or_default();
        return crate::notice::queue(
            app,
            conversation_id,
            text,
            crate::notice::Queued::Unattended,
        );
    }
    let note = crate::presence::defer(
        app,
        conversation_id,
        args,
        crate::presence::Queued::Unattended,
    );

    /* **And it has to make a noise, which away mode does not have to.**
       Coming back from away *opens* the pile, so a question queued then is
       read within seconds of there being anybody to read it. A question
       queued while the user is right here has no such moment: it was amber in
       the dock, it vanishes, and all that is left is a count appearing in the
       bar — which is quieter than what it replaced, on the one wall where the
       user is actually present. Leaving it at that would be answering "the
       agent decided without me" with "the question went away", which is a
       different failure and not obviously a smaller one.

       A chronicle row, which is the wall's existing answer to "something
       happened that you were not looking at" — it is read as a wisp when it
       lands and as a row for ever after, so it survives not being seen. Not
       the attention ladder: the taskbar flash and the peek are for a card
       that is *blocked*, and this card is not blocked any more. See
       `.claude/rules/chronicle.md`.

       Only when the wall is here. Away mode has its own, better moment. */
    if !crate::presence::away(app) {
        crate::chronicle::note(
            app,
            None,
            "volery",
            "note",
            "a question timed out and was queued for you",
            "nothing was decided — read it from the pile (space then q)",
        );
    }
    note
}

fn park_and_stream(
    app: &AppHandle,
    asks: &Asks,
    conversation_id: &str,
    id: &Value,
    args: &Value,
    progress: Option<Value>,
    req: tiny_http::Request,
    settle: Option<Settle>,
    act: Option<(String, Value)>,
) {
    let (ask_id, rx, stirred, held) =
        open_ask(app, asks, conversation_id, args, settle.is_some(), act.clone());
    let forget = || {
        asks.pending.lock().unwrap().remove(&ask_id);
    };
    let closed = |answered: bool, deferred: bool, said: Option<String>| {
        let _ = app.emit(
            "ask:closed",
            AskClosed {
                ask_id: ask_id.clone(),
                answered,
                deferred,
                said,
            },
        );
    };

    let mut w = req.into_writer();
    let head = "HTTP/1.1 200 OK\r\n\
                Content-Type: text/event-stream\r\n\
                Cache-Control: no-cache\r\n\
                Transfer-Encoding: chunked\r\n\
                \r\n";
    /* A comment in the same breath as the headers. A response whose headers are
       held back until its first byte of body has said nothing yet, whatever its
       status line claims. */
    if w
        .write_all(head.as_bytes())
        .and_then(|()| chunk(&mut *w, ": parked\n\n"))
        .is_err()
    {
        forget();
        closed(false, false, None);
        return;
    }

    let started = Instant::now();
    /* Scaled to what was asked. The *arguments* are settled before the wait and
       cannot change under a parked call — but the deadline itself now can, and
       only in one direction and for one reason: the user touching the panel
       moves it out (`held_window`, `stir_ask`). So the base is computed once
       and the deadline is re-read each tick, which is the distinction the
       earlier note here was drawing and is worth keeping sharp. */
    let base = answer_window(args);
    let mut fed: u64 = 0;
    /* Set when the reply carries a sheet the user was partway through: the
       answers they gave, and whether anything was left over for the pile. */
    let mut partial: Option<bool> = None;
    let answer = loop {
        match rx.recv_timeout(FEED_EVERY) {
            Ok(a) => break a,
            /* The sender was dropped — the card was closed while it was
               asking. */
            Err(RecvTimeoutError::Disconnected) => break DISMISSED.to_string(),
            Err(RecvTimeoutError::Timeout) => {
                let since = stirred.lock().unwrap().saturating_duration_since(started);
                let window = held_window(base, since);
                if started.elapsed() >= window {
                    /* Taken off the wall here. If it is already gone, something
                       else claimed it this instant — the answer, or the wall
                       going away — and what it sent is on the channel or about
                       to be, so that goes out rather than a timeout racing it. */
                    if asks.pending.lock().unwrap().remove(&ask_id).is_none() {
                        break rx.recv().unwrap_or_else(|_| DISMISSED.to_string());
                    }
                    let kept = held.lock().unwrap().take();
                    partial = kept.as_ref().map(|h| h.rest.is_some());
                    break expired(app, conversation_id, args, &settle, &act, window, kept);
                }
                fed += 1;
                /* With a progress token this is a real notification, which
                   resets the CLI's idle watchdog as well as feeding the socket;
                   without one it can only be a comment, which every SSE parser
                   is required to ignore. The SDK sends a token whenever it
                   registers an `onprogress`, which it always does — but the
                   bytes are worth having on their own, and inventing a token to
                   carry them is not. */
                let note = match &progress {
                    Some(token) => sse(&json!({
                        "jsonrpc": "2.0",
                        "method": "notifications/progress",
                        "params": {
                            "progressToken": token,
                            "progress": fed,
                            "message": "waiting for the user"
                        }
                    })),
                    None => ": waiting\n\n".to_string(),
                };
                if chunk(&mut *w, &note).is_err() {
                    /* The client hung up. Nothing will ever read this answer, so
                       the question comes down rather than standing on the wall
                       over an agent that has moved on — which is what the
                       blocking park did for its whole life, being unable to tell
                       a listener from a dropped connection. */
                    forget();
                    closed(false, false, None);
                    return;
                }
            }
        }
    };

    /* Three ways this is not an answer, and the third is the newest: away mode
       converting a question that was already on the wall (`presence::flip`).
       Matched on the opening rather than on a sentinel, which is the idiom this
       loop already uses for the timeout — the string the agent reads and the
       string this thread recognises are one thing, so there is no second
       vocabulary to keep in step. */
    /* The other way a sheet partway through gets closed: the wall going away,
       which composed the reply in `presence::defer_parked` from the same hold.
       Recognised by the reply opening with exactly what this thread holds —
       the same string rather than a second wording of it, so there is nothing
       to keep in step, and a reply the user *sent* cannot match, because a
       hold always names what it is short of (`not reached`, or the unsent
       sheet) and a sent sheet never does. Only for `ask_user`: a question
       carrying a settle or an act is never converted with its hold. */
    if partial.is_none() && settle.is_none() && act.is_none() {
        partial = carried(held.lock().unwrap().as_ref(), &answer);
    }
    /* Neither is an answer the user sent, and the rest went to the pile if
       there was any. */
    let deferred = crate::presence::is_deferral(&answer) || partial == Some(true);
    let real = partial.is_none()
        && !deferred
        && !answer.starts_with(TIMED_OUT_OPENING)
        && answer != DISMISSED;
    /* The settle runs *here*, on the parking thread, after the answer is in and
       before the reply goes out — which is what makes a `close` genuinely
       deferred rather than merely delayed. It is also the last moment at which
       the wall is still current: ten minutes have passed, and the card the user
       was asked about may since have started a turn, been set aside, or gone.
       So `spawn::close` re-reads all of it rather than trusting what it saw
       when it composed the question. */
    let reply = match settle {
        /* Never on a deferral — a settle is an *act*, and `defer_parked` is why
           a question carrying one is not converted in the first place. Guarded
           here as well because the two facts live in different files, and the
           one that would be wrong here is a close performed because the wall
           went quiet. */
        Some(decide) if !deferred => decide(app, if real { Some(answer.as_str()) } else { None }),
        Some(_) => answer.clone(),
        None => answer.clone(),
    };
    let delivered = chunk(
        &mut *w,
        &sse(&json!({
            "jsonrpc": "2.0", "id": id,
            "result": { "content": [{ "type": "text", "text": reply }] }
        })),
    )
    .and_then(|()| w.write_all(b"0\r\n\r\n"))
    .and_then(|()| w.flush())
    .is_ok();

    /* Answered, but only if it arrived: a click whose reply never left is not
       something the agent can act on, and the note the transcript keeps for a
       question that closed without one is true of both. */
    closed(
        real && delivered,
        deferred,
        partial.filter(|_| delivered).map(|_| answer.clone()),
    );
}

/// Mark a tool as wanted on every turn, whatever tool search would otherwise do.
///
/// `_meta["anthropic/alwaysLoad"]` is the per-tool half of what `mcp_config`
/// used to say once for the whole server. Read out of the 2.1.241 binary —
/// `alwaysLoad: e.config.alwaysLoad===!0 || M._meta?.["anthropic/alwaysLoad"]===!0`
/// — and confirmed live by `tools/probe-tiers.ts`, which put the flag on two of
/// four tools and watched the other two arrive as bare names.
///
/// It is applied here, at the roster, rather than inside each schema function,
/// so the tier is one list you can read top to bottom. A tool's own module
/// should not have to know how expensive the wall's prompt is.
fn always(mut schema: Value) -> Value {
    schema["_meta"]["anthropic/alwaysLoad"] = json!(true);
    schema
}

/// This tool only reads, and **that is the difference between being callable in
/// plan mode and not being callable at all**.
///
/// Claude Code refuses every MCP tool to a planning card unless the tool says it
/// is read-only. Nothing here said so, so nothing here was reachable: a card in
/// plan mode could not read the sink it is told to read, could not read the
/// billboard it is told to read *before working in a shared repository*, and
/// could not ask the user a question. What it got instead was
/// `Cannot call mcp__skein__board while in plan mode.` — with the description
/// that told it to call `board` still in its prompt, because the roster below is
/// the only copy of that instruction.
///
/// Probed at claude 2.1.241 with a stub server carrying two otherwise identical
/// tools, one annotated and one bare:
///
/// ```text
/// init  mode=plan  offered: [mcp__stub__peek_annotated, mcp__stub__peek_bare]
///   mcp__stub__peek_annotated  ALLOWED  "peek_annotated ran fine."
///   mcp__stub__peek_bare       BLOCKED  "Cannot call mcp__stub__peek_bare while in plan mode."
/// ```
///
/// Note both were *offered* — the annotation does not change what a planning
/// card is told it has, only what happens when it reaches. So an unannotated
/// read-only tool is worse than an absent one: it is advertised, described, and
/// refused at the moment of use.
///
/// **Only `readOnlyHint`.** The spec offers three more, `destructiveHint` is
/// defined to be ignored wherever this one is true, and none of the others is
/// read by anything measured here. One hint with one meaning is a thing that can
/// be right; four, of which three are decoration, is four things to drift.
///
/// The bar is *this wall's state as a caller can change it*, not a literal claim
/// that no byte moves. A tool that writes a row, a notice, an image or another
/// card's turn **on the strength of being called** is not read-only however
/// harmless it looks — `send` costs another agent a turn, which is a change to
/// something somebody is watching.
///
/// **Two of these do write, and the qualifier above is where they fit.** `board`
/// sweeps expired notices on the read path (`board::do_board` → `sweep`, which
/// `drop_notice`s and writes an inbox row per affected card) and `sink` sweeps
/// expired holds. Both are kept annotated, and both are honest here because the
/// write is **driven by the clock rather than by the caller**: `read_board` does
/// the identical sweep on every paint of the panel, so a planning card asking
/// changes nothing that was not already going to happen the next time anybody
/// looked. Refusing a planning card the billboard — the one thing every card is
/// told to read *before working in a shared repository* — would be the larger
/// error by a distance. State it as the rule for tool seventeen: **a caller may
/// not cause a change; time may.**
///
/// `ask_user` is the judgement call and it is deliberate. Not because it changes
/// nothing — it emits `ask:opened`, puts the card in the asking tier, opens the
/// `peek` window, flashes the taskbar, may chime, and holds the call open for the
/// whole answer window. The narrower claim is the one that survives: **it writes
/// nothing another agent can trip over, and the only thing it spends is the
/// user's attention — which is precisely what a planning card is *for*.** A card
/// that cannot ask what it is planning for is not a gear, it is a broken card,
/// and the roster is the only copy of the instruction telling it to ask.
fn reads_only(mut schema: Value) -> Value {
    schema["annotations"]["readOnlyHint"] = json!(true);
    schema
}

/// What to match a deferred tool on, when an agent goes looking for a capability
/// rather than a name.
///
/// **Not rendered into the deferred listing, and load-bearing anyway** — which
/// is the whole reason a discoverable tier is affordable. `formatDeferredToolLine`
/// is `function iFa(e){ return e.name }`, so a deferred tool costs its name and
/// nothing else per turn; the hint is read only by `ToolSearch`'s matcher.
///
/// Probed as a controlled pair on 2026-08-27 (`probe-tiers.ts --search-only`,
/// with and without, one query, everything else identical): with a hint the tool
/// ranked **first** for a query sharing no token with its name; without one it
/// did not place in the top five at all. So a hint is not decoration. **A tool
/// in the deferred tier and carrying no hint is a tool nobody will find**, and
/// `every_deferred_tool_can_be_found` refuses one.
///
/// They are written wide on purpose. A card reaching for one of these is
/// usually holding the words of its own problem rather than the name of the
/// tool — "is anyone in my way" long before "touched" — so the hints carry the
/// question as well as the noun.
fn found_by(mut schema: Value, hint: &str) -> Value {
    schema["_meta"]["anthropic/searchHint"] = json!(hint);
    schema
}

/// Every tool this server advertises, in two tiers.
///
/// **The first tier is not a taste, it is a rule with two clauses**, and
/// `.claude/rules/ask.md` states it in full: *a loaded description is either the
/// prompt's referent or the prompt's replacement, and only a tool that is
/// neither can be deferred.* The first clause is checkable — a tool
/// `supervisor::append_prompt` names must be here, or the one paragraph every
/// card pays for points at identifiers whose schemas were withheld, and
/// `the_prompt_names_only_tools_the_server_advertises` guards the names while
/// this guards their descriptions. The second is not checkable by anything and
/// is the one that grew: `1856ded` cut the board paragraph and the `drop`
/// sentence out of the prompt *because* they restated these descriptions, so
/// those descriptions are now the only copy of the instruction rather than a
/// second one. Defer `board` and nothing in front of an agent says to read the
/// billboard before working in a shared repository. `sink` is loaded on the same
/// footing as `drop` — a card told to file findings and not told it can read
/// them files duplicates.
///
/// The four after that are there on a different argument, and it is the one
/// `append_prompt` used to make for `drop`: **a description is only read by an
/// agent that has thought to look for a tool**, and these exist to replace
/// something an agent does wrongly by *default*. `pin` fights writing a path
/// into the transcript, `wake_me` fights sleeping inside a turn, `allowance`
/// fights guessing at the budget, and `servers` fights shelling out `pnpm dev`
/// in a territory whose dev servers the wall is already running. Nothing in a
/// schema reaches a reflex, and nothing in `ToolSearch` reaches one either,
/// because the failure is not searching in the first place — which is exactly
/// what happened: a card launched a backend and Metro by hand with both already
/// defined, autostarted and *up*, then had no log and probed the wedged one over
/// HTTP three times onto a queue the user was already waiting on (sink
/// `11365b64`). It never called `servers`, and its hint would have matched
/// perfectly if it had searched.
///
/// **Only `servers` was promoted, and the other two stay deferred on purpose.**
/// It is the free, read-only one, it is the call that has to come first anyway,
/// and its own *answer* names `server_log` and `server` in full — which is a
/// tool result and costs nothing per turn. Measured against
/// `the_loaded_tier_is_what_every_turn_pays_for`'s own arithmetic: the tier was
/// 20,751 bytes over 11 tools and is 21,924 over 12, so `servers` costs 1,173 —
/// 939 of the schema as it stood, and the rest the sentence that makes loading it
/// worth anything, which is not a cost to be economised on. All three would leave
/// the tier with about 800 bytes of slack, which is the state that made the
/// tiering a conversation in the first place; this left 2,076.
///
/// **Those are the figures of the day they were taken and they are no longer the
/// state of the tier — read them as history, and get the current number from the
/// test.** On 2026-10-06 that paragraph was read as a live measurement by
/// somebody adding a few hundred bytes of schema: it says 2,076 of slack, the
/// real figure was 528, and the release built from it went red on this very
/// assertion at 26,506 against the 26,000 ceiling. A tag published with no
/// installer behind it, which is the expensive end of this mistake.
///
/// Measured that day after trimming: **25,756 bytes, 244 of slack.** The tier is
/// effectively full. There is no cheap way to take this reading on a machine
/// with no MSVC — `cargo check` compiles the assertion and never runs it, and
/// `roster()` reaches the whole crate so it cannot be lifted the way `swallowed`
/// is (sink `46a9ea47`). Until that changes, anything added here is verified by
/// CI or not at all, and the honest move is to assume there is no room.
///
/// Everything below is a capability a card knows it wants from the prompt it
/// was given — it is working on a pull request, or it is not — and those are
/// deferred with a hint. Measured 2026-08-27: 22 tools cost 38,598 bytes on
/// every spawn of every card; this arrangement costs what
/// `the_loaded_tier_is_what_every_turn_pays_for` asserts.
pub(crate) fn roster() -> Vec<Value> {
    vec![
        // ── loaded: the prompt's referent, or the last copy of its instruction ──
        always(reads_only(tool_schema())),
        always(reads_only(crate::board::board_schema())),
        always(crate::board::post_schema()),
        always(crate::board::unpost_schema()),
        always(reads_only(crate::sink::sink_schema())),
        always(crate::sink::drop_schema()),
        always(reads_only(crate::relay::list_schema())),
        always(crate::relay::send_schema()),
        // ── loaded: reflex-shaped, where not looking is the failure ──
        always(crate::pin::pin_schema()),
        always(crate::later::wake_schema()),
        always(reads_only(crate::limits::allowance_schema())),
        always(reads_only(crate::servers::servers_schema())),
        always(crate::chronicle::wisp_schema()),
        // ── discoverable: a card knows from its prompt whether it wants these ──
        /* Deferred, and the hint carries the *words* rather than the noun: a
           card reaching for this has just been told "I'm off to bed", "going
           out", "back tomorrow" — nobody says "set presence". What makes it
           findable at all is that the user's own sentence is in the card's
           hands when it searches. */
        found_by(
            crate::presence::schema(),
            "the user said they are stepping away — out for lunch, back in twenty, \
             off to the gym, taking a break, leaving for the evening, going to bed, \
             back tomorrow — stop notifying them and queue questions instead of \
             parking on them",
        ),
        /* Deferred, with one sentence in `supervisor::append_prompt` naming
           the search rather than the tool — the timeline arrangement. The user
           asked that cards use it sparingly; loaded on every card it would be
           in front of every agent on every turn, which is the opposite. */
        found_by(
            crate::notice::schema(),
            "notify the user, tell the user now, heads up, warn them, alert, \
             announce, let them know I am starting something disruptive, found a \
             serious bug, data at risk, before a restart or a migration, a notice \
             in their queue",
        ),
        found_by(
            crate::sink::take_schema(),
            "claim a sink item before starting it; hold, assign, take, release, \
             unclaim, is anyone already doing this",
        ),
        /* Deferred: `sink`'s own answer names it in full beside the ids to hand
           it, which is `servers`' argument for `server_log` — a tool result costs
           nothing per turn, and the loaded tier had 576 bytes left. */
        found_by(
            reads_only(crate::sink::sink_read_schema()),
            "read a sink item in full, its body and files and settling note, open \
             the items the sink listed, look up a sink id, what does this finding say",
        ),
        found_by(
            crate::sink::done_schema(),
            "mark a sink item finished, settled, resolved, close it out, tick it \
             off, I fixed the bug that was filed",
        ),
        found_by(
            reads_only(crate::chronicle::chronicle_schema()),
            "what has been happening on this wall, catch up on the other cards, what \
             have they finished or broken, recent activity, what did I miss, the feed \
             or notification history — not who is working on what, which is the board",
        ),
        found_by(
            reads_only(crate::status::status_schema()),
            "is claude down, is it me or them, api error, 500, overloaded, rate \
             limited, request failed for no reason, outage, service status, is the \
             api having problems",
        ),
        found_by(
            reads_only(crate::relay::touched_schema()),
            "who else has edited this file, other agents, conflict, clash, is \
             anyone in my way, am I about to work over somebody, recent writes",
        ),
        found_by(
            reads_only(crate::relay::recall_schema()),
            "what did another card do or say, read its words, catch up on a \
             conversation, what happened there, without costing it a turn",
        ),
        /* Deferred although `wake_me` is loaded, and the reflex it answers is
           the same one — forgetting. What reaches that reflex is not this
           schema but `wake_me`'s own description and its receipt, which names
           this tool in full beside the id to hand it: a tool result costs
           nothing per turn, which is `servers`' argument for its two siblings. */
        found_by(
            crate::later::cancel_schema(),
            "cancel a wake, disarm a wake_me, the background job finished before \
             the fallback, stop being woken later, unschedule a reminder I set, \
             I am done and a wake is still armed",
        ),
        found_by(
            crate::pin::repin_schema(),
            "update or move or remove an image already on the wall, replace a \
             screenshot with a newer render, take a picture down",
        ),
        found_by(
            reads_only(crate::pin::pinned_schema()),
            "what images has this card put on the wall, what have I pinned \
             already, list my pins before pinning another",
        ),
        /* Timelines. Deferred, and the one prompt sentence that points at them
           names a *search* rather than a tool — `supervisor::append_prompt` —
           so these hints are what that search lands on. They carry the words
           of the work rather than the noun: nobody thinks "timeline" when they
           start an epic, they think "plan", "milestones", "show progress". */
        found_by(
            crate::timeline::set_schema(),
            "timeline progress bar plan roadmap milestones epic phases stages \
             steps sub-steps show the user how far along the work is, draw my \
             plan on the wall, long multi-step task, parallel strands background \
             work — not for a quick fix",
        ),
        found_by(
            crate::timeline::mark_schema(),
            "update timeline progress, mark a step done, tick off a milestone, \
             advance the progress bar, set a sub-step active, move the plan \
             along, go back a step",
        ),
        found_by(
            reads_only(crate::timeline::read_schema()),
            "read my timeline, how far along is another card's work, check the \
             progress of a card I spawned, see a plan's steps and their paths",
        ),
        found_by(
            crate::timeline::complete_schema(),
            "finish the timeline, the epic is done, close out the plan, all \
             milestones reached, mark the progress bar complete",
        ),
        found_by(
            crate::spawn::spawn_schema(),
            "open another card, start a second conversation, delegate a separate \
             job, run work in parallel, hand something to a new agent, fan out \
             the building work, spawn several agents to implement, choose which \
             model an agent runs on, haiku sonnet opus, which account or \
             subscription it spends",
        ),
        found_by(
            reads_only(crate::limits::accounts_schema()),
            "which claude accounts or subscriptions are on this wall, list account \
             labels, which account am I on, which one has room, pick an account \
             for a new card, priority tiers, is another account usable",
        ),
        found_by(
            crate::spawn::close_schema(),
            "take a card off the wall, close a conversation I opened, tidy up a \
             child card that has finished and reported",
        ),
        found_by(
            reads_only(crate::servers::server_log_schema()),
            "local dev server output on this machine, local build error, local \
             compile failure, stack trace, vite next pnpm dev tsc output, why \
             did the dev server fall over, read the log — not a CI or pipeline \
             run",
        ),
        found_by(
            crate::servers::server_schema(),
            "start or stop or restart a dev server group, bring it up, kill it, \
             cycle the server after a config change",
        ),
        /* The forge. These three read oddly wide and it is the one fact about
           them that is not a fact about this roster: **a card reaching for the
           forge has usually just failed with `az`**, which cannot reach
           `dev.azure.com` on this network at all — see `smith.rs`'s header on
           the TLS interception. So it is searching for the word in its hand,
           `certificate` or `ssl` or the failed command itself, rather than for
           a noun it does not know this server has. And nobody thinks
           "pipelines"; they think "did my build pass".

           **Every build word here is qualified `CI`, `pipeline` or `remote`,
           and that is a collision fix rather than verbosity.** `server_log`
           two entries up carries `build error` and `compile failure`, and
           "my build failed, what happened" is the single likeliest thing
           anybody types at either of them — while the two answer completely
           different questions, one reading a dev server's stdout on this
           machine and one reading a CI run in an Azure DevOps organisation. A
           card sent to the wrong one does not get an error; it gets a confident
           answer about the wrong build, which is the worst shape this failure
           has. Found by 3f08dc99 reading the whole list at once, which is the
           property that made putting the hints here rather than in each module
           worth it. **`server_log`'s half is now done too** (sink a0106918):
           every build word in its hint is qualified `local`, `on this machine`
           or named after a local tool, and it ends by saying what it is *not*.
           The pair reads as a pair — `CI`/`pipeline`/`remote` against
           `local`/`dev server` — which is the property worth keeping, since the
           matcher scores text and a qualifier only separates two tools if both
           of them carry one. Qualify only the winner and the loser still ranks
           on the bare noun. */
        found_by(
            reads_only(crate::smith::pipelines_schema()),
            "azure devops pipelines CI build remote build builds ci status runs \
             workflow actions did my build pass on CI check the pipeline is the \
             pipeline green az pipelines certificate error ssl self-signed",
        ),
        found_by(
            reads_only(crate::smith::reviews_schema()),
            "pull request PR review reviews approved votes merge conflicts open \
             PRs is my PR approved who reviewed az repos pr list gh pr list \
             certificate error",
        ),
        found_by(
            crate::smith::pull_request_schema(),
            "create pull request open a PR raise a PR edit PR title description \
             update PR body az repos pr create gh pr create certificate error ssl",
        ),
        /* Asana. The hints carry **the words on the ticket rather than the name
           of the service**, because a card is usually holding a sentence
           somebody typed — "the RISE board", "what's assigned to me" — and does
           not know this wall has an Asana connection at all.

           Two collisions were fixed here rather than discovered later, and both
           are with tools that are *already* about pieces of work:

           - **`take` and `done` are the sink's**, and they own the plain words
             `claim`, `finished` and `tick it off`. So every hint below is
             qualified `asana`, `board`, `ticket` or `column`, and `done`'s
             sense of finishing is deliberately not claimed by `task` — a card
             that means the sink's pile must not land on somebody's Asana.
           - **`tasks` against Claude Code's own `Task`/`TaskOutput`**, which
             are subagents and have nothing to do with either. Nothing here can
             stop that being typed, but the hint names Asana, a board and an
             assignee in the first breath, which is what the matcher scores.

           `task`'s hint says **asks first** in as many words. That is not
           decoration: an agent choosing between doing something itself and
           parking a turn on somebody's attention should know which it is
           picking before it picks, and the hint is the only text it reads
           before the schema. */
        found_by(
            reads_only(crate::docket::tasks_schema()),
            "asana tasks assigned to me my tickets what am I working on read the asana board \
             a project's columns kanban backlog sprint what does the ticket say read a task \
             description acceptance criteria",
        ),
        found_by(
            crate::docket::task_schema(),
            "create an asana task edit a ticket move a card to another column change the \
             status on the board comment on a ticket tick off an asana task delete a task \
             update the description — asks the user first",
        ),
        /* The escape hatch, and its hint is written to be found by a card that
           has already hit the wall rather than by one shopping for a
           capability — `attachment`, `subtask`, `webhook` and `portfolio` are
           the words in its hand, because they are the things `task` does not
           do. It deliberately does **not** claim the ordinary verbs: a card
           searching "create an asana task" must land on `task`, which asks for
           one thing, and not on the tool that hands over the whole account. */
        found_by(
            crate::docket::token_schema(),
            "asana api directly personal access token PAT credential attachment subtask \
             portfolio goal webhook custom field admin bulk asana endpoint the task tool \
             cannot do this",
        ),
        /* The delete, and its hint is written for a card that has already
           been stopped rather than one shopping for a capability. What is in
           its hand at that moment is a *failure* — "permission denied",
           "operation not permitted" — or the words of the thing it wanted:
           clear the build cache, blow away `.next`, get rid of this directory.
           Nobody thinks "remove"; they think *"how do I delete this"*.

           **The shell spellings are in the hint on purpose**, and they are the
           part carrying the load. Sink `14f2543e` is a card that hit a denied
           `rm -rf` and reached for `mv` — so the words most likely to be in
           front of an agent at the moment this tool would help are the ones it
           just typed, and a hint that names only the noun would not have
           matched any of them. */
        found_by(
            crate::remove::remove_schema(),
            "delete a directory or file, remove a folder, rm -rf denied permission, clear the \
             build cache, blow away .next dist target node_modules .turbo, get rid of this \
             directory, how do I delete this, operation not permitted deleting, \
             Remove-Item -Recurse -Force, find -delete, mv it out of the way",
        ),
        /* The music. Both hints are written in **the words a person says about
           music** rather than around either tool's name, because nobody thinks
           "records" — they think "put something on".

           `put_on`'s hint carries every phrasing that means *choosing* and none
           that means *driving*: no pause, no skip, no volume, no louder or
           quieter. That is not an oversight to be tidied up later. A card
           holding "turn it down" finds nothing on this server, and finding
           nothing is the correct answer — the user keeps the transport, and this
           function is the one place an agent actually goes looking, so it is
           where the scoping has to hold as well as in the schemas. */
        found_by(
            reads_only(crate::selector::records_schema()),
            "search spotify for music find a song track album playlist artist \
             what is this song called look up a record catalogue what should we \
             listen to",
        ),
        found_by(
            crate::selector::put_on_schema(),
            "put music on play an album put some jazz on choose what plays change \
             the music start a playlist something to listen to while I work",
        ),
    ]
}

/// What a JSON-RPC message means, decided without touching the network so it
/// can be tested directly.
#[derive(Debug, PartialEq)]
pub(crate) enum Dispatch {
    /// A notification: acknowledge with 202 and no body.
    Accepted,
    /// Answer immediately with this result.
    Reply(Value),
    /// A `tools/call`. `tool` is what to do about it — `ask_user` parks until
    /// the user answers, and everything else is `relay.rs`'s, answered at once.
    ///
    /// The name used to be dropped here, there having been one tool. Reading it
    /// is the whole of what made a second one possible: this file stays the
    /// transport and still decides nothing about what any tool *means*.
    /// `progress` is the client's `_meta.progressToken` — protocol rather than
    /// arguments, which is why this file reads it where it reads nothing out of
    /// `args`. Without it a parked question can only feed the socket comments;
    /// with it, each keep-alive is a notification the client's *own* idle
    /// watchdog counts as the server being alive.
    Call {
        id: Value,
        tool: String,
        args: Value,
        progress: Option<Value>,
    },
    /// Answer with a JSON-RPC error for this method name.
    Unknown { id: Value, method: String },
}

pub(crate) fn dispatch(rpc: &Value) -> Dispatch {
    // Notifications carry no id and expect no body.
    let Some(id) = rpc.get("id").cloned() else {
        return Dispatch::Accepted;
    };
    let method = rpc.get("method").and_then(Value::as_str).unwrap_or("");

    match method {
        "initialize" => Dispatch::Reply(json!({
            "jsonrpc": "2.0", "id": id,
            "result": {
                "protocolVersion": rpc
                    .get("params")
                    .and_then(|p| p.get("protocolVersion"))
                    .cloned()
                    .unwrap_or_else(|| json!("2025-06-18")),
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "skein", "version": env!("CARGO_PKG_VERSION") }
            }
        })),
        "tools/list" => Dispatch::Reply(json!({
            "jsonrpc": "2.0", "id": id,
            "result": { "tools": roster() }
        })),
        "ping" => Dispatch::Reply(json!({ "jsonrpc": "2.0", "id": id, "result": {} })),
        "tools/call" => Dispatch::Call {
            id,
            /* Absent rather than defaulted to `ask_user`: a call naming no tool
               is a client we do not understand, and parking one on a question
               nobody asked would be the loudest possible way to be wrong about
               it. An unnamed tool falls through to the roster below, which
               answers that it has no such tool. */
            tool: rpc
                .get("params")
                .and_then(|p| p.get("name"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            /* Cleaned here, before anything reads a field out of it, because
               this is the one place arguments are lifted out of the wire and
               the caps downstream do not cover all of them — a glob, an id, an
               Asana task's name and a question parked for the user all reach
               their surface without passing `clip::keep`. `crate::clean` has
               what an impossible character is, and why taking one out is
               silent rather than refused or announced. */
            args: {
                let mut args = rpc
                    .get("params")
                    .and_then(|p| p.get("arguments"))
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                scrub_json(&mut args);
                args
            },
            progress: rpc
                .get("params")
                .and_then(|p| p.get("_meta"))
                .and_then(|m| m.get("progressToken"))
                .cloned()
                .filter(|t| !t.is_null()),
        },
        other => Dispatch::Unknown {
            id,
            method: other.to_string(),
        },
    }
}

/// The conversation id is the last path segment of `/mcp/<id>`, so a call
/// arrives already addressed to a card with no correlation logic anywhere.
pub(crate) fn conversation_of(url: &str) -> &str {
    url.split('?')
        .next()
        .unwrap_or(url)
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or_default()
}

/// A call whose own text swallowed one of its arguments.
///
/// `lost` never arrived; `inside` is the argument whose text is carrying its
/// declaration instead.
#[derive(Debug, PartialEq)]
pub(crate) struct Swallowed {
    pub(crate) lost: String,
    pub(crate) inside: String,
}

/// The literal a mis-written tool call leaves behind in the argument above it.
const DECLARATION: &str = "<parameter name=";

/// Every string anywhere in a value, in order.
fn strings_in<'a>(v: &'a Value, out: &mut Vec<&'a str>) {
    match v {
        Value::String(s) => out.push(s),
        Value::Array(a) => a.iter().for_each(|x| strings_in(x, out)),
        Value::Object(o) => o.values().for_each(|x| strings_in(x, out)),
        _ => {}
    }
}

/// The argument names declared by literal `<parameter name="…">` tags in a text.
fn declarations(text: &str) -> Vec<&str> {
    let mut names = Vec::new();
    let mut rest = text;
    while let Some(i) = rest.find(DECLARATION) {
        rest = &rest[i + DECLARATION.len()..];
        let quote = match rest.as_bytes().first() {
            Some(b'"') => '"',
            Some(b'\'') => '\'',
            _ => continue,
        };
        rest = &rest[1..];
        let Some(j) = rest.find(quote) else { break };
        names.push(&rest[..j]);
        rest = &rest[j + 1..];
    }
    names
}

/// Whether one of this call's arguments is sitting inside another one as text.
///
/// The client composes a `tools/call` by writing tagged parameters and parsing
/// them back out, and a tag written without its namespace prefix is not a tag —
/// it is more of the parameter above it. Reported 2026-09-02: an `ask_user`
/// whose `options` was written as a bare `<parameter name="options">` arrived
/// with the whole literal `</question> <parameter name="options">[{…}]`
/// concatenated onto the end of `question`, and no `options` at all. The user
/// read a wall of raw JSON and XML where three buttons should have been, and
/// nothing at either end said so: the call succeeded, the question was answered,
/// and the agent had no way to know it had degraded a click into a paragraph.
///
/// The signature is precise enough to act on, which is why this is a refusal
/// rather than a note. A text declaring an argument that **is** on this tool's
/// schema and **is not** in this call is not prose about the syntax — it is the
/// argument, in the wrong place. Both halves are needed: the first keeps a card
/// quoting some other program's XML out of it, and the second is the escape
/// hatch, since a card genuinely writing about `<parameter name="paths">` need
/// only pass `paths` for the call to go through.
///
/// **This is the one thing Rust reads out of `arguments`, and it is not a breach
/// of the bargain the rest of this file keeps** (`asking.ts::normalizeAsk` owns
/// what a question *is*). It reads no field by name and knows no vocabulary: it
/// asks only whether the encoding survived the wire, which is the same question
/// `dispatch` answers about `_meta`'s progress token. It has to be here because
/// both costs land before the front end sees anything — the mangled prose goes
/// in front of a person, and every other tool on this server has already done
/// its write by the time it returns a string.
pub(crate) fn swallowed(args: &Value, declared: &[&str]) -> Option<Swallowed> {
    let obj = args.as_object()?;
    for (key, value) in obj {
        let mut texts = Vec::new();
        strings_in(value, &mut texts);
        for text in texts {
            for name in declarations(text) {
                if declared.contains(&name) && !obj.contains_key(name) {
                    return Some(Swallowed {
                        lost: name.to_string(),
                        inside: key.clone(),
                    });
                }
            }
        }
    }
    None
}

/// The same question against the live roster, gated on the cheap half first —
/// `roster()` builds two dozen schemas, and the literal is absent from every
/// well-formed call ever made.
fn swallowed_by(tool: &str, args: &Value) -> Option<Swallowed> {
    let mut texts = Vec::new();
    strings_in(args, &mut texts);
    if !texts.iter().any(|t| t.contains(DECLARATION)) {
        return None;
    }
    let schema = roster()
        .into_iter()
        .find(|t| t.get("name").and_then(Value::as_str) == Some(tool))?;
    let props = schema
        .get("inputSchema")
        .and_then(|s| s.get("properties"))
        .and_then(Value::as_object)?;
    let declared: Vec<&str> = props.keys().map(String::as_str).collect();
    swallowed(args, &declared)
}

/// What the agent is told about a call that lost an argument to its own text.
///
/// It says nothing happened first, because that is the part that decides what to
/// do next, and it names the escape hatch last so a card that really did mean to
/// quote the syntax is not stuck.
pub(crate) fn swallowed_note(tool: &str, m: &Swallowed) -> String {
    format!(
        "skein refused this {tool} call, and nothing was done — no question was \
         shown, nothing was written, nobody was notified.\n\n\
         The text of `{inside}` contains a literal `<parameter name=\"{lost}\">` \
         declaration, and no `{lost}` argument arrived with the call. That means \
         `{lost}` was never parsed as an argument at all: it was read as more of \
         `{inside}`, and would have been shown to the user as prose.\n\n\
         The cause is a `<parameter>` tag written without the namespace prefix \
         the rest of the call uses, or a parameter closed with the argument's \
         own name rather than with the matching closing tag. Write the call \
         again with every tag in the same namespaced form, each parameter \
         closed by its own closing tag.\n\n\
         If you did mean that text literally, pass `{lost}` as well — this is \
         only refused when the argument is named in the text and missing from \
         the call.",
        tool = tool,
        inside = m.inside,
        lost = m.lost,
    )
}

/// A question whose options are bare labels, with nothing to choose between
/// them by.
///
/// **178 of Lyss's answers to `ask_user` show the question itself was the
/// problem, and about 30 of them send it straight back** (sink `b260f62a`) —
/// *"when askings, give me pros and cons for each option so that my judgment
/// is aware"*, *"what are the stakes"*, *"i don't have the context you have,
/// what's the matter"*. Each of those is a round trip: her turn to ask, the
/// card's turn to answer, and the decision still not made.
///
/// The model has the context and she does not; that asymmetry is the whole
/// reason the tool exists, and a call that does not spend any of it on her is
/// a call that has moved the work rather than done it.
///
/// **The trigger is as narrow as it can be while still catching that.** Two or
/// more options and *not one of them* carries a `detail`. One option is not a
/// choice; a call where some options are described and some are not is a judgement
/// about which needed describing, and that judgement is the model's to make.
/// What is left is the shape that was actually complained about — a row of bare
/// words with no way in.
///
/// **And a picture is a way in.** Three options each carrying a `preview` or a
/// `file`, labelled A, B and C, have no `detail` anywhere and are not the
/// complaint: the thing to judge them by is on the screen at full size, and a
/// line of prose under each would be describing what the user is looking at.
/// That shape is the flagship use of both fields — several designs side by
/// side, several renders to pick between — so refusing it would aim this
/// squarely at the calls that spend the *most* of the model's context on her.
/// Caught when the two landed in the same week; the note over `undescribed_note`
/// says why a false positive here is worse than one in `swallowed`, and this is
/// what one would have looked like.
fn thin_options(q: &Value) -> bool {
    let Some(opts) = q.get("options").and_then(Value::as_array) else {
        return false;
    };
    let shown = |o: &Value, k: &str| o.get(k).is_some_and(|v| !v.is_null());
    opts.len() >= 2
        && !opts.iter().any(|o| {
            o.get("detail")
                .and_then(Value::as_str)
                .is_some_and(|d| !d.trim().is_empty())
                || shown(o, "preview")
                || shown(o, "file")
        })
}

/// Every question in a call, whichever form it arrived in.
///
/// The two forms are the tool's own (`question` + `options`, or `questions[]`),
/// and neither may be `required` — see `tool_schema`. So both are read, and a
/// call carrying both is read as both rather than one being preferred: this is
/// a check, and a check that looked at only half of a malformed call would be
/// the gap rather than the guard.
fn questions_in(args: &Value) -> Vec<&Value> {
    let mut out: Vec<&Value> = Vec::new();
    if args.get("question").is_some() || args.get("options").is_some() {
        out.push(args);
    }
    if let Some(qs) = args.get("questions").and_then(Value::as_array) {
        out.extend(qs.iter());
    }
    out
}

/// How many of this call's questions offer a choice with nothing to choose by.
pub(crate) fn undescribed(args: &Value) -> usize {
    questions_in(args).into_iter().filter(|q| thin_options(q)).count()
}

/// What the agent is told about it.
///
/// Shaped like `swallowed_note` and for its reasons: it says nothing happened
/// first, because that is the part that decides what to do next, and it is
/// specific about the fix so the re-ask is one tool call rather than a guess.
///
/// **Where the trade-offs go is the half worth saying.** `detail` is drawn on a
/// button and is one line by design — the panel lives in the dock and grows
/// upward into the wall, so pros and cons under four buttons is a dock that has
/// eaten the studio. The question body is markdown, it scrolls, and it is where
/// a table of trade-offs belongs. An agent told only "add detail" writes four
/// paragraphs onto four buttons.
pub(crate) fn undescribed_note(n: usize) -> String {
    let which = if n == 1 {
        "A question in this call offers".to_string()
    } else {
        format!("{n} questions in this call offer")
    };
    format!(
        "skein refused this ask_user call, and nothing was done — no question \
         was shown and the user was not interrupted.\n\n\
         {which} two or more options and not one of them carries a `detail`. \
         The user does not have the context you have, so a row of bare labels \
         asks them to decide from less than you know — which in practice means \
         they ask you what the options mean, and the decision costs three turns \
         instead of one.\n\n\
         Ask it again with:\n\n\
         - a one-line `detail` on each option, saying what picking it *means* — \
         not a restatement of the label;\n\
         - the trade-offs in the question body, where there is room for them. \
         It is markdown and it scrolls; a table or a short list per option reads \
         well. `detail` is drawn on a button and cannot hold them;\n\
         - your recommendation first, and said out loud in the question. \
         \"I'd pick B\" with the reason is worth more than a neutral list — you \
         have read the code and they have not.\n\n\
         If the choice genuinely needs no explaining, ask it with one option or \
         with none and a free-text answer: this is only refused for two or more \
         options where every one of them is a bare label."
    )
}

/// Take the impossible characters out of every string in a JSON value, in
/// place.
///
/// Object *keys* are left alone on purpose. On the way in, a key carrying a
/// control character is a key that matches no field of any schema and is
/// therefore already inert; on the way out every key in this file is a literal
/// written here. Rebuilding the map to clean something that cannot be dirty
/// would cost an allocation on every response for nothing.
fn scrub_json(v: &mut Value) {
    match v {
        Value::String(s) => {
            if let std::borrow::Cow::Owned(clean) = crate::clean::scrub(s) {
                *s = clean;
            }
        }
        Value::Array(items) => items.iter_mut().for_each(scrub_json),
        Value::Object(map) => map.values_mut().for_each(scrub_json),
        _ => {}
    }
}

/// The one place a body leaves this server, which is why the read-side guard is
/// here rather than in each of the fifteen `handle` arms above.
///
/// It is not redundant with the guard on the way in. What it catches is text
/// that never passed a write at all — a git error, a server log, a file's
/// contents quoted into a receipt — and the rows that were already in the store
/// when this shipped. See `crate::clean`.
fn respond(req: tiny_http::Request, mut body: Value) {
    scrub_json(&mut body);
    let data = body.to_string();
    let header = tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
        .expect("static header");
    let _ = req.respond(tiny_http::Response::from_string(data).with_header(header));
}

/// The one route on this listener that is not MCP: start the shared browser.
///
/// **A hook is a process, and a process cannot start a browser this app is
/// allowed to own.** The lazy browser needs something in front of a card's
/// first `mcp__browser__*` call to put a Chrome up, and the only thing standing
/// there is the `PreToolUse` hook (`hooks::reply`) — which is a short-lived
/// child of the card, not of Volery. If *it* spawned Chrome, the Chrome would
/// be a child of a process that exits immediately: outside Volery's job object,
/// unreaped when the wall closes, invisible to the widget, and unknown to
/// `browser_stop`. That is the orphan `CLAUDE.md` describes as "the one that did
/// not was the biggest", built on purpose.
///
/// So the hook asks, and Volery does it. This listener is what the hook can
/// reach: it is already bound, already on loopback, already addressed to this
/// wall, and its port is already being written into the card's own argv — so
/// carrying it one flag further costs nothing and invents no second channel.
///
/// Not under `/mcp/`, and the path is checked before `conversation_of` runs,
/// because that function reads the *last* segment as a conversation id and
/// would cheerfully report this one as a card called `wake`.
///
/// **It names no card and is not authenticated**, which is worth stating rather
/// than leaving to be noticed. Every other route on this listener carries a
/// conversation id; this one has nothing to correlate — the browser is the
/// wall's, there is one of it, and starting it is the same act whoever asked.
/// So any process on this machine can cause a ~450 MB Chrome to start. The
/// listener was already loopback-only and already unauthenticated, and CDP on
/// 9222 is reachable by anything local regardless, so this widens nothing that
/// was not already open — but it is the first route here whose side effect
/// costs memory, and a second one should not be added on the strength of this
/// one existing.
pub const WAKE_PATH: &str = "/browser/wake";

/// Where `hooks.rs` hands over a shell delete it stopped, as
/// `POST /remove/shell/<card id>` with `{ "command", "paths" }` in the body.
///
/// **A hook cannot call an MCP tool**, so this is the tool's decision reached
/// by the one other door into this process: the same refusals, the same survey,
/// the same question on the same card, and — for a path `remove::unasked` lets
/// through — the same immediate delete. The body of the reply is the sentence
/// `remove` would have returned, and the hook hands it to the model inside a
/// denial, because the shell must never run the command itself (sink
/// `b3d1036c`).
///
/// **It does not hold the hook for as long as the question stands**, and that
/// was the first design and the reason it changed. A hook the CLI kills prints
/// nothing, and printing nothing *runs the command* — so a delete parked past
/// the `PreToolUse` ceiling would have gone through the shell after all, and
/// nothing had measured whether the CLI honours a fifteen-minute ceiling at all.
/// So the whole of it runs on its own thread (`hand_off`) and the request waits
/// at most [`HAND_OFF_WAIT`]: a refusal, a temp delete or a quick click comes
/// back in the reply; anything slower is told to the card later, as a message
/// from the wall, by the thread that saw it through.
pub const REMOVE_PATH: &str = "/remove/shell/";

/// How long [`REMOVE_PATH`] holds its request before telling the hook the
/// question is standing. Under `hooks::ROUTE_TIMEOUT`, which is under the
/// `PreToolUse` ceiling, so the hook always has its answer before it is killed.
pub const HAND_OFF_WAIT: Duration = Duration::from_secs(25);

/// What the hook is told when the decision outlasted [`HAND_OFF_WAIT`].
///
/// Worded for both of the ways that happens, because it is said before this
/// side knows which: the user has not answered the question on the card yet,
/// or there was no question and a large no-click temp delete is still running.
const STILL_ASKING: &str = "that is still being dealt with — either the user has been asked on \
     your card and has not answered yet, or it needed no question and a large delete is still \
     running. You do not need to wait for it or ask again: when it is done, the wall will send \
     you what happened as a message of its own. Carry on with something that does not need it \
     gone, or end your turn.";

/// What the hook is told when the thread doing the work died without a word.
/// Not [`STILL_ASKING`], which promises a message nothing is left to send.
const WENT_WRONG: &str = "Volery failed while handling that delete and cannot say how far it \
     got. Check whether the path still exists before doing anything else, and tell the user; \
     if it is still there, `mcp__skein__remove` asks again from the start.";

/// Run a shell delete through `remove` on a thread of its own, and give the
/// request whatever it has by [`HAND_OFF_WAIT`].
///
/// The one race is the thread finishing at the moment the wait gives up, and
/// the `Option` is what settles it: whoever takes the sender decides. The
/// thread takes it to reply; the request takes it to say "still asking", and
/// then the thread, finding it gone, delivers late instead. Neither can lose
/// the outcome and neither can report it twice.
fn hand_off(app: &AppHandle, card: &str, command: &str, paths: Vec<String>) -> String {
    let (tx, rx) = mpsc::channel::<String>();
    let reply = std::sync::Arc::new(Mutex::new(Some(tx)));
    let (app2, card2, cmd2, reply2) =
        (app.clone(), card.to_string(), command.to_string(), reply.clone());
    std::thread::spawn(move || {
        let said = match crate::remove::from_shell(&app2, &card2, &cmd2, &paths) {
            crate::remove::Writing::Now(said) => said,
            crate::remove::Writing::Ask { question, settle } => {
                /* Away: queued as a request rather than parked, and the thread
                   is free. This is the path that mattered most to queue — a
                   card tidying up its own `.scratch-<handle>/` after an
                   experiment, which is the commonest delete on this wall and
                   the one a night of refusals leaves lying around. */
                if crate::presence::away(&app2) {
                    crate::presence::defer_act(
                        &app2,
                        &card2,
                        crate::presence::REMOVE_ACT,
                        &crate::remove::shell_args(&cmd2, &paths),
                        &question,
                        "deleting what your shell line named",
                    )
                } else {
                    park_and_wait(
                        &app2,
                        &app2.state::<Asks>(),
                        &card2,
                        &question,
                        settle,
                        Some((
                            crate::presence::REMOVE_ACT.to_string(),
                            crate::remove::shell_args(&cmd2, &paths),
                        )),
                    )
                }
            }
        };
        let taken = reply2.lock().ok().and_then(|mut r| r.take());
        match taken {
            Some(tx) => {
                let _ = tx.send(said);
            }
            None => crate::remove::deliver_late(&app2, &card2, &cmd2, &said),
        }
    });
    match rx.recv_timeout(HAND_OFF_WAIT) {
        Ok(said) => said,
        /* The sender dropped unsent: the thread panicked. Nothing will deliver
           late, so promising a message would be a card waiting for nothing. */
        Err(RecvTimeoutError::Disconnected) => WENT_WRONG.to_string(),
        Err(RecvTimeoutError::Timeout) => {
            let taken = reply.lock().map(|mut r| r.take().is_some()).unwrap_or(false);
            if taken {
                STILL_ASKING.to_string()
            } else {
                /* The thread took the sender first and is sending now — or died
                   between taking it and sending. */
                rx.recv().unwrap_or_else(|_| WENT_WRONG.to_string())
            }
        }
    }
}

/// Park a question with no request behind it, and return what the settle made
/// of the answer.
///
/// `park_and_stream`'s lifecycle without its transport — `hand_off`'s thread is
/// the only thing waiting, so there is no socket to keep alive and no client to
/// notice hanging up. What is kept exactly is the part with consequences: the
/// window, the dismissal, the `ask:closed` that takes the question down, and the
/// settle running here after the answer.
fn park_and_wait(
    app: &AppHandle,
    asks: &Asks,
    conversation_id: &str,
    question: &Value,
    settle: Settle,
    act: Option<(String, Value)>,
) -> String {
    let (ask_id, rx, stirred, _) = open_ask(app, asks, conversation_id, question, true, act);
    let base = answer_window(question);
    /* A tick loop rather than one flat `recv_timeout(window)`, for the one
       reason `park_and_stream` grew the same shape: the deadline moves while
       the user is typing (`held_window`), so it has to be re-read rather than
       decided once. There is nothing to feed on this path — the caller is
       Volery itself and no socket is being held open — so the tick is only
       how often the question is asked. See `ANSWER_HOLD`. */
    let started = Instant::now();
    let answer = loop {
        match rx.recv_timeout(FEED_EVERY) {
            Ok(a) => break Some(a),
            Err(RecvTimeoutError::Disconnected) => break None,
            Err(RecvTimeoutError::Timeout) => {
                let since = stirred.lock().unwrap().saturating_duration_since(started);
                if started.elapsed() >= held_window(base, since) {
                    asks.pending.lock().unwrap().remove(&ask_id);
                    break None;
                }
            }
        }
    };
    let real = answer.as_deref().is_some_and(|a| a != DISMISSED);
    let reply = settle(app, if real { answer.as_deref() } else { None });
    let _ = app.emit(
        "ask:closed",
        AskClosed {
            ask_id,
            answered: real,
            /* `park_and_wait` only ever carries a settle, and a question
               carrying one is never converted. */
            deferred: false,
            said: None,
        },
    );
    reply
}


/// Bind on an ephemeral loopback port and serve until the process exits.
/// Returns the port so `spawn_conversation` can point `--mcp-config` at it.
pub fn start(app: AppHandle) -> Result<u16, String> {
    let server = tiny_http::Server::http("127.0.0.1:0")
        .map_err(|e| format!("bind ask server: {e}"))?;
    let port = server
        .server_addr()
        .to_ip()
        .ok_or("ask server has no ip address")?
        .port();

    std::thread::spawn(move || {
        for mut req in server.incoming_requests() {
            let app = app.clone();
            /* A parked question blocks its request for up to ten minutes, so
               every request gets its own thread — otherwise one card waiting on
               you would stall every other card's MCP traffic. */
            std::thread::spawn(move || {
                if req.method() != &tiny_http::Method::Post {
                    let _ = req.respond(tiny_http::Response::empty(405));
                    return;
                }

                /* Before the body is read and before the url is read as a card,
                   because this one is neither. Blocking here for the length of
                   a Chrome start is exactly right and is why the thread-per-
                   request above exists — a parked question already holds one
                   for up to ten minutes, so a browser coming up is the cheap
                   case. The reason travels in the body of a 503 so the hook can
                   put Volery's own words in front of the model rather than
                   playwright's `ECONNREFUSED`. */
                if req.url().split('?').next().unwrap_or_default() == WAKE_PATH {
                    match crate::browser::ensure_running(&app) {
                        Ok(()) => {
                            let _ = req.respond(tiny_http::Response::empty(204));
                        }
                        Err(e) => {
                            let _ = req.respond(
                                tiny_http::Response::from_string(e).with_status_code(503),
                            );
                        }
                    }
                    return;
                }

                if req.url().starts_with(REMOVE_PATH) {
                    let card = conversation_of(req.url()).to_string();
                    let mut body = String::new();
                    let parsed = std::io::Read::read_to_string(req.as_reader(), &mut body)
                        .ok()
                        .and_then(|_| serde_json::from_str::<Value>(&body).ok());
                    let Some(body) = parsed else {
                        let _ = req.respond(tiny_http::Response::empty(400));
                        return;
                    };
                    let command = body.get("command").and_then(Value::as_str).unwrap_or("");
                    let paths: Vec<String> = crate::remove::paths_from(&body);
                    let said = hand_off(&app, &card, command, paths);
                    let _ = req.respond(tiny_http::Response::from_string(said));
                    return;
                }

                let conversation_id = conversation_of(req.url()).to_string();

                let mut body = String::new();
                if std::io::Read::read_to_string(req.as_reader(), &mut body).is_err() {
                    let _ = req.respond(tiny_http::Response::empty(400));
                    return;
                }
                let Ok(rpc) = serde_json::from_str::<Value>(&body) else {
                    let _ = req.respond(tiny_http::Response::empty(400));
                    return;
                };

                match dispatch(&rpc) {
                    Dispatch::Accepted => {
                        let _ = req.respond(tiny_http::Response::empty(202));
                    }
                    Dispatch::Reply(body) => respond(req, body),
                    Dispatch::Unknown { id, method } => respond(
                        req,
                        json!({
                            "jsonrpc": "2.0", "id": id,
                            "error": { "code": -32601, "message": format!("no method {method}") }
                        }),
                    ),
                    Dispatch::Call {
                        id,
                        tool,
                        args,
                        progress,
                    } => {
                        /* Before any arm, because every arm is too late. The
                           two that park put the mangled text in front of a
                           person, and the whole chain below has already done
                           its write by the time it returns a string to say so.
                           See `swallowed`. */
                        if let Some(m) = swallowed_by(&tool, &args) {
                            respond(
                                req,
                                json!({
                                    "jsonrpc": "2.0", "id": id,
                                    "result": {
                                        "content": [
                                            { "type": "text",
                                              "text": swallowed_note(&tool, &m) }
                                        ],
                                        "isError": true
                                    }
                                }),
                            );
                            return;
                        }

                        /* And the second refusal, on the same argument one
                           layer in: that one is a call whose text ate an
                           argument, this one is a call that asks the user to
                           decide from less than the model knows. Both are
                           refused before any arm for the same reason — the
                           cost lands on a person the moment the question is
                           drawn, and a note returned afterwards is a note
                           about an interruption that already happened.
                           `ask_user` only: no other tool on this server puts a
                           choice in front of anybody. See `undescribed`. */
                        if tool == "ask_user" {
                            let n = undescribed(&args);
                            if n > 0 {
                                respond(
                                    req,
                                    json!({
                                        "jsonrpc": "2.0", "id": id,
                                        "result": {
                                            "content": [
                                                { "type": "text",
                                                  "text": undescribed_note(n) }
                                            ],
                                            "isError": true
                                        }
                                    }),
                                );
                                return;
                            }
                        }

                        /* Two tools park, and everything else is answered on
                           this thread and returns in milliseconds, well inside
                           every clock either side of this connection has. Which
                           is also why the roster tools were put on this server
                           rather than beside it — a call that is not a question
                           costs nothing here, and the client already trusts this
                           endpoint. */
                        if tool == "ask_user" {
                            /* The attachments first, because every path below
                               is too late: the away branch stores these
                               arguments in the pile and the parking branch
                               draws them. See `attach_files`. */
                            let args = match attach_files(&app, &conversation_id, args) {
                                Ok(v) => v,
                                Err(why) => {
                                    respond(
                                        req,
                                        json!({
                                            "jsonrpc": "2.0", "id": id,
                                            "result": {
                                                "content": [{
                                                    "type": "text",
                                                    "text": format!(
                                                        "{why}\n\nNothing was asked, so the \
                                                         decision is still outstanding — put \
                                                         the call back together and send it \
                                                         again."
                                                    )
                                                }],
                                                "isError": true
                                            }
                                        }),
                                    );
                                    return;
                                }
                            };

                            /* Away mode, and the whole of what it changes here:
                               the call does not park at all. Nobody is going to
                               answer inside any of the three deadlines this
                               file spends two thousand words on, so holding the
                               request open buys nothing and costs the card its
                               turn. The question goes in the pile and the agent
                               is told what that means. */
                            if crate::presence::away(&app) {
                                let note = crate::presence::defer(
                                    &app,
                                    &conversation_id,
                                    &args,
                                    crate::presence::Queued::Away,
                                );
                                respond(
                                    req,
                                    json!({
                                        "jsonrpc": "2.0", "id": id,
                                        "result": { "content": [
                                            { "type": "text", "text": note }
                                        ] }
                                    }),
                                );
                                return;
                            }
                            let asks = app.state::<Asks>();
                            park_and_stream(
                                &app,
                                &asks,
                                &conversation_id,
                                &id,
                                &args,
                                progress,
                                req,
                                None,
                                None,
                            );
                            return;
                        }

                        /* `notice` parks only when it was asked to wait, and
                           only while somebody is at the wall — otherwise it is a
                           row in the queue and an answer on the spot. Here
                           rather than in the roster chain for `close`'s reason
                           below: that chain has already committed to answering. */
                        if tool == crate::notice::NOTICE_TOOL {
                            let reply = |req: tiny_http::Request, text: String, error: bool| {
                                respond(
                                    req,
                                    json!({
                                        "jsonrpc": "2.0", "id": id,
                                        "result": {
                                            "content": [{ "type": "text", "text": text }],
                                            "isError": error
                                        }
                                    }),
                                );
                            };
                            let text = match crate::notice::text_of(&args) {
                                Ok(t) => t,
                                Err(why) => return reply(req, why, true),
                            };
                            if !crate::notice::waits(&args) || crate::presence::away(&app) {
                                let why = if crate::notice::waits(&args) {
                                    crate::notice::Queued::Away
                                } else {
                                    crate::notice::Queued::Sent
                                };
                                let said =
                                    crate::notice::queue(&app, &conversation_id, &text, why);
                                return reply(req, said, false);
                            }
                            /* Before parking, not on the way out: a full queue
                               found when the wait expires would have nowhere to
                               put the text. */
                            if !crate::notice::has_room(&app, &conversation_id) {
                                return reply(req, crate::notice::full_note(), false);
                            }
                            let asks = app.state::<Asks>();
                            park_and_stream(
                                &app,
                                &asks,
                                &conversation_id,
                                &id,
                                &crate::notice::parked_payload(&text),
                                progress,
                                req,
                                None,
                                None,
                            );
                            return;
                        }

                        /* `close` is the second, and only sometimes: a card
                           closing one of its own is answered at once as it
                           always was, and only a card naming somebody else's
                           puts a question up and waits. So the decision cannot
                           live in the roster chain below — that arm has already
                           committed to answering — and it must not be taken
                           twice either, since two readings of the same wall are
                           two things to keep in step. `spawn::close` decides
                           once and hands back what to do about it. */
                        /* `spawn` naming another wall is the fourth, and
                           always: the answer comes from that wall, a few
                           seconds away at best. Routed here, ahead of the
                           roster chain, for `close`'s reason — that chain has
                           already committed to answering on the spot. A
                           `spawn` with no `host` (or this wall's own name) is
                           not caught and goes down the chain as it always
                           has. */
                        if tool == crate::spawn::SPAWN_TOOL && crate::spawn::names_another_wall(&args) {
                            match crate::spawn::elsewhere(&app, &conversation_id, &args) {
                                crate::spawn::Elsewhere::Now(said) => respond(
                                    req,
                                    json!({
                                        "jsonrpc": "2.0", "id": id,
                                        "result": { "content": [
                                            { "type": "text", "text": said }
                                        ] }
                                    }),
                                ),
                                crate::spawn::Elsewhere::Wait(rx, host) => park_for_answer(
                                    &id,
                                    progress,
                                    req,
                                    rx,
                                    /* As long as the ask can still be acted on
                                       there, and half a minute for the answer
                                       to come back — past that the far wall
                                       refuses it as expired, so nothing it says
                                       can be "opened" unless a card really was. */
                                    Duration::from_millis(
                                        (crate::flyway::fleet::ASK_TTL_MS + 30_000) as u64,
                                    ),
                                    &format!("waiting for {host} to open the card"),
                                    crate::spawn::elsewhere_waiting(&host),
                                ),
                            }
                            return;
                        }

                        if tool == crate::spawn::CLOSE_TOOL {
                            match crate::spawn::close(&app, &conversation_id, &args) {
                                crate::spawn::Closing::Now(said) => {
                                    respond(
                                        req,
                                        json!({
                                            "jsonrpc": "2.0", "id": id,
                                            "result": { "content": [
                                                { "type": "text", "text": said }
                                            ] }
                                        }),
                                    );
                                }
                                crate::spawn::Closing::Ask { question, settle } => {
                                    /* Away: this does not park either, and
                                       unlike a question it is queued as a
                                       *request* — the settle is dropped on the
                                       floor and `presence::answer_deferred_act`
                                       builds a fresh one by asking this same
                                       function again when the user is back.
                                       That is what "if it is still relevant"
                                       means, and it is why the arguments are
                                       stored rather than the decision. */
                                    if crate::presence::away(&app) {
                                        let note = crate::presence::defer_act(
                                            &app,
                                            &conversation_id,
                                            crate::spawn::CLOSE_TOOL,
                                            &args,
                                            &question,
                                            "closing that card",
                                        );
                                        respond(
                                            req,
                                            json!({
                                                "jsonrpc": "2.0", "id": id,
                                                "result": { "content": [
                                                    { "type": "text", "text": note }
                                                ] }
                                            }),
                                        );
                                        return;
                                    }
                                    let asks = app.state::<Asks>();
                                    park_and_stream(
                                        &app,
                                        &asks,
                                        &conversation_id,
                                        &id,
                                        &question,
                                        progress,
                                        req,
                                        Some(settle),
                                        Some((crate::spawn::CLOSE_TOOL.to_string(), args.clone())),
                                    );
                                }
                            }
                            return;
                        }

                        /* `unpost` is the third, and sometimes, for exactly
                           `close`'s reason one tool over: taking down one of
                           your own answers at once as it always has, and only
                           naming a *dead* card's notice puts a question up. The
                           poster-only rule is right about a live card — its
                           notice is a claim it is still making — and had no
                           answer at all for a card killed mid-turn, whose hold
                           therefore stood for ever. `board::unpost` decides
                           once, because two readings of the same wall are two
                           things to keep in step. */
                        if tool == crate::board::UNPOST_TOOL {
                            match crate::board::unpost(&app, &conversation_id, &args) {
                                crate::board::Unposting::Now(said) => {
                                    respond(
                                        req,
                                        json!({
                                            "jsonrpc": "2.0", "id": id,
                                            "result": { "content": [
                                                { "type": "text", "text": said }
                                            ] }
                                        }),
                                    );
                                }
                                crate::board::Unposting::Ask { question, settle } => {
                                    /* Away: this does not park either, and
                                       unlike a question it is queued as a
                                       *request* — the settle is dropped on the
                                       floor and `presence::answer_deferred_act`
                                       builds a fresh one by asking this same
                                       function again when the user is back.
                                       That is what "if it is still relevant"
                                       means, and it is why the arguments are
                                       stored rather than the decision. */
                                    if crate::presence::away(&app) {
                                        let note = crate::presence::defer_act(
                                            &app,
                                            &conversation_id,
                                            crate::board::UNPOST_TOOL,
                                            &args,
                                            &question,
                                            "taking that notice down",
                                        );
                                        respond(
                                            req,
                                            json!({
                                                "jsonrpc": "2.0", "id": id,
                                                "result": { "content": [
                                                    { "type": "text", "text": note }
                                                ] }
                                            }),
                                        );
                                        return;
                                    }
                                    let asks = app.state::<Asks>();
                                    park_and_stream(
                                        &app,
                                        &asks,
                                        &conversation_id,
                                        &id,
                                        &question,
                                        progress,
                                        req,
                                        Some(settle),
                                        Some((crate::board::UNPOST_TOOL.to_string(), args.clone())),
                                    );
                                }
                            }
                            return;
                        }

                        /* `pull_request` is the fourth, and always. It opens or
                           edits a pull request on somebody's Azure DevOps
                           organisation, under the user's own name, on a server
                           this app does not own — **the first effect on this
                           server that reaches outside this machine**, and one no
                           card can take back: it lands on other people's review
                           queue and nothing here can un-notify anybody.

                           So the decision is taken here for `close`'s reason,
                           and unconditionally where `close` is conditional. A
                           card closing one of its own is answered at once
                           because the wall is the caller's to arrange; there is
                           no equivalent of "one of its own" for a pull request.
                           In the roster chain below this would be a write that
                           never asked, since that arm has already committed to
                           answering on the spot. `smith::pull_request` decides
                           once and hands back what to do about it — every
                           refusal and every argument problem comes back as
                           `Now`, so nothing reaches a person until the call is
                           well-formed enough to be worth their attention. */
                        if tool == crate::smith::PULL_REQUEST_TOOL {
                            match crate::smith::pull_request(&app, &conversation_id, &args) {
                                crate::smith::Writing::Now(said) => {
                                    respond(
                                        req,
                                        json!({
                                            "jsonrpc": "2.0", "id": id,
                                            "result": { "content": [
                                                { "type": "text", "text": said }
                                            ] }
                                        }),
                                    );
                                }
                                crate::smith::Writing::Ask { question, settle } => {
                                    /* Not deferred while away, deliberately:
                                       these write to somebody else's service,
                                       where `presence.rs`'s re-entry can check
                                       nothing about what has changed overnight.
                                       See `away.md`. */
                                    let asks = app.state::<Asks>();
                                    park_and_stream(
                                        &app,
                                        &asks,
                                        &conversation_id,
                                        &id,
                                        &question,
                                        progress,
                                        req,
                                        Some(settle),
                                        None,
                                    );
                                }
                            }
                            return;
                        }

                        /* `task` is the fifth, and always — the same block as
                           `pull_request` for the same reason, one service over.
                           It creates, edits, moves, comments on, ticks or
                           deletes a task in somebody's Asana workspace, under
                           the user's own name, on a board other people read.

                           The gate is *wider* here than the forge's and that is
                           deliberate rather than cautious. `smith.rs` can scope
                           a card to its own territory, because the
                           org/project/repo triple comes off the card's own git
                           remote and a card physically cannot name somebody
                           else's repository. Asana has no such anchor — a
                           project is not derivable from a working directory —
                           and an Asana PAT is unscoped, so the confirmation is
                           standing in for a scope that does not exist. Hence
                           every action parks, including the ones that look
                           small: `docket::task` decides once and hands back
                           what to do about it, and every refusal and argument
                           problem comes back as `Now`, so nothing reaches a
                           person until the call is worth their attention.

                           `asana_token` comes through the same arm and is the
                           sharper case: it hands the card the **unscoped PAT
                           itself**, which is the one secret anything on this
                           server gives away. `docket::writes` is asked which
                           tools park rather than the condition being spelled
                           out here, because that is a fact about that module —
                           and a tool that ought to park, left out of a list
                           kept over here, is an unattended write with nothing
                           anywhere to say so. */
                        /* `remove` is the sixth, and always — the only one
                           of these whose effect is **on this machine and
                           irreversible**. The forge and Asana write outside and
                           can at least be edited afterwards by a person; a
                           deleted directory is gone, and `.claude/rules/undo.md`
                           is explicit that the stack cannot reach a file.

                           It parks unconditionally, and the tiering that would
                           have let a build cache through on the card's own word
                           is deliberately not built — see `remove.rs`'s header.
                           `remove::writes` decides once and hands back what to
                           do about it; every refusal and every argument problem
                           comes back as `Now`, so nothing reaches a person
                           until the call is worth their attention, and the
                           refusals that make this safe to offer at all are
                           re-checked again on the way out. */
                        if let Some(writing) =
                            crate::remove::writes(&app, &conversation_id, &tool, &args)
                        {
                            match writing {
                                crate::remove::Writing::Now(said) => {
                                    respond(
                                        req,
                                        json!({
                                            "jsonrpc": "2.0", "id": id,
                                            "result": { "content": [
                                                { "type": "text", "text": said }
                                            ] }
                                        }),
                                    );
                                }
                                crate::remove::Writing::Ask { question, settle } => {
                                    /* Away: this does not park either, and
                                       unlike a question it is queued as a
                                       *request* — the settle is dropped on the
                                       floor and `presence::answer_deferred_act`
                                       builds a fresh one by asking this same
                                       function again when the user is back.
                                       That is what "if it is still relevant"
                                       means, and it is why the arguments are
                                       stored rather than the decision. */
                                    if crate::presence::away(&app) {
                                        let note = crate::presence::defer_act(
                                            &app,
                                            &conversation_id,
                                            crate::presence::REMOVE_ACT,
                                            &args,
                                            &question,
                                            "deleting what you named",
                                        );
                                        respond(
                                            req,
                                            json!({
                                                "jsonrpc": "2.0", "id": id,
                                                "result": { "content": [
                                                    { "type": "text", "text": note }
                                                ] }
                                            }),
                                        );
                                        return;
                                    }
                                    let asks = app.state::<Asks>();
                                    park_and_stream(
                                        &app,
                                        &asks,
                                        &conversation_id,
                                        &id,
                                        &question,
                                        progress,
                                        req,
                                        Some(settle),
                                        Some((crate::presence::REMOVE_ACT.to_string(), args.clone())),
                                    );
                                }
                            }
                            return;
                        }

                        if let Some(writing) =
                            crate::docket::writes(&app, &conversation_id, &tool, &args)
                        {
                            match writing {
                                crate::docket::Writing::Now(said) => {
                                    respond(
                                        req,
                                        json!({
                                            "jsonrpc": "2.0", "id": id,
                                            "result": { "content": [
                                                { "type": "text", "text": said }
                                            ] }
                                        }),
                                    );
                                }
                                crate::docket::Writing::Ask { question, settle } => {
                                    /* Not deferred while away, deliberately:
                                       these write to somebody else's service,
                                       where `presence.rs`'s re-entry can check
                                       nothing about what has changed overnight.
                                       See `away.md`. */
                                    let asks = app.state::<Asks>();
                                    park_and_stream(
                                        &app,
                                        &asks,
                                        &conversation_id,
                                        &id,
                                        &question,
                                        progress,
                                        req,
                                        Some(settle),
                                        None,
                                    );
                                }
                            }
                            return;
                        }

                        let answer = crate::relay::handle(&app, &conversation_id, &tool, &args)
                            .or_else(|| crate::board::handle(&app, &conversation_id, &tool, &args))
                            .or_else(|| crate::sink::handle(&app, &conversation_id, &tool, &args))
                            .or_else(|| {
                                crate::chronicle::handle(&app, &conversation_id, &tool, &args)
                            })
                            .or_else(|| crate::limits::handle(&app, &conversation_id, &tool, &args))
                            /* Takes neither the app nor the caller: it asks a
                               public page a question with no arguments, and the
                               answer is the same for every card on the wall. */
                            .or_else(|| crate::status::handle(&tool, &args))
                            .or_else(|| crate::later::handle(&app, &conversation_id, &tool, &args))
                            .or_else(|| {
                                crate::presence::handle(&app, &conversation_id, &tool, &args)
                            })
                            .or_else(|| crate::pin::handle(&app, &conversation_id, &tool, &args))
                            .or_else(|| {
                                crate::timeline::handle(&app, &conversation_id, &tool, &args)
                            })
                            .or_else(|| crate::spawn::handle(&app, &conversation_id, &tool, &args))
                            /* Last in the chain and answered on this thread
                               like the rest of it, which is the thing to check
                               before adding anything else here: `server` can
                               spend a second or two killing a process tree and
                               spawning another, where every other arm returns
                               in milliseconds. That is affordable only because
                               `ask::start` gives each request its own thread —
                               so this parks nobody but its own caller, which is
                               a card that asked for a restart and can wait for
                               one. It must not become a `#[tauri::command]`. */
                            .or_else(|| {
                                crate::servers::handle(&app, &conversation_id, &tool, &args)
                            })
                            /* The forge's two *readings*, and they belong here
                               rather than above precisely because they read.
                               They are slower than the rest of this chain —
                               `pipelines` makes one request per project in the
                               organisation, sequentially, against a ten-second
                               connect timeout — which is affordable for the
                               reason `servers` is: this parks nobody but its own
                               caller, on a thread `ask::start` gave it. The
                               forge's *write* is not in this chain; see the
                               block above. */
                            .or_else(|| crate::smith::handle(&app, &conversation_id, &tool, &args))
                            /* Asana's *reading*, here rather than above for the
                               reason the forge's two are: it reads. It is the
                               slowest arm in this chain — `tasks` with no
                               arguments is one request per workspace, and a
                               board is three — which is affordable on the same
                               bargain, that this parks nobody but its own
                               caller on a thread `ask::start` gave it. Asana's
                               *write* is not in this chain; see the block
                               above. */
                            .or_else(|| crate::docket::handle(&app, &conversation_id, &tool, &args))
                            /* The music, last for the same reason and on the
                               same bargain: `records` is a `GET /v1/search`
                               against api.spotify.com and blocks this thread
                               while it runs. `put_on` does not go out at all —
                               it is a local call on the Spirc handle — and it
                               is *not* the write that needs a block of its own
                               above, because there is nothing for the user to
                               approve: it refuses by itself while they are
                               listening, which is the whole of its restraint. */
                            .or_else(|| {
                                crate::selector::handle(&app, &conversation_id, &tool, &args)
                            })
                            .unwrap_or_else(|| format!("this server has no tool {tool:?}"));
                        respond(
                            req,
                            json!({
                                "jsonrpc": "2.0", "id": id,
                                "result": { "content": [{ "type": "text", "text": answer }] }
                            }),
                        );
                    }
                }
            });
        }
    });

    Ok(port)
}

use tauri::Manager;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_notification_gets_acknowledged_with_no_body() {
        let n = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        assert_eq!(dispatch(&n), Dispatch::Accepted);
    }

    #[test]
    fn initialize_echoes_the_client_protocol_version() {
        let r = dispatch(&json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2024-11-05" }
        }));
        let Dispatch::Reply(v) = r else { panic!("expected a reply") };
        assert_eq!(v["result"]["protocolVersion"], "2024-11-05");
        assert_eq!(v["result"]["serverInfo"]["name"], "skein");
        assert_eq!(v["id"], 1);
    }

    #[test]
    fn initialize_falls_back_when_the_client_names_no_version() {
        let r = dispatch(&json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize" }));
        let Dispatch::Reply(v) = r else { panic!("expected a reply") };
        assert!(v["result"]["protocolVersion"].is_string());
    }

    #[test]
    fn tools_list_advertises_ask_user_with_a_usable_schema() {
        let r = dispatch(&json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }));
        let Dispatch::Reply(v) = r else { panic!("expected a reply") };
        let tool = &v["result"]["tools"][0];
        let props = &tool["inputSchema"]["properties"];
        assert_eq!(tool["name"], "ask_user");
        // Options are what make an answer a click instead of a sentence.
        assert!(props["options"].is_object());
        // Both forms are offered: one decision stays a one-line call, and
        // several go in `questions` rather than being fused into one.
        assert!(props["question"].is_object());
        assert!(props["questions"]["items"]["properties"]["question"].is_object());
        assert!(props["questions"]["items"]["properties"]["header"].is_object());
    }

    /// Neither form may be `required`, or a call using the other one is refused
    /// by the client before it ever reaches us — and a refused ask is an agent
    /// that stops asking. `normalizeAsk` is what handles a call carrying
    /// neither.
    #[test]
    fn neither_form_of_the_question_is_demanded() {
        let r = dispatch(&json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }));
        let Dispatch::Reply(v) = r else { panic!("expected a reply") };
        assert!(v["result"]["tools"][0]["inputSchema"]["required"].is_null());
    }

    /// A preview is offered everywhere a design could be attached, and demanded
    /// nowhere. The second half is the same rule as the question forms above:
    /// almost every ask is a sentence and some buttons, and a schema that made
    /// `preview` mandatory would refuse all of them at the client.
    #[test]
    fn a_design_may_be_shown_at_every_level_and_is_required_at_none() {
        let r = dispatch(&json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }));
        let Dispatch::Reply(v) = r else { panic!("expected a reply") };
        let props = &v["result"]["tools"][0]["inputSchema"]["properties"];

        // On an option: the comparison, which is what this is for.
        let opt = &props["options"]["items"];
        assert!(opt["properties"]["preview"]["properties"]["html"].is_object());
        assert_eq!(opt["required"], json!(["label"]));

        // On a question: the approval, where there is one design and a yes.
        assert!(props["preview"].is_object());
        let q = &props["questions"]["items"];
        assert!(q["properties"]["preview"].is_object());
        assert_eq!(q["required"], json!(["question"]));

        // Markup is the whole of a preview — `css` and `js` are each optional,
        // and a preview with no `html` is an empty frame, which reads as a
        // design that failed to load rather than as an option without one.
        assert_eq!(props["preview"]["required"], json!(["html"]));
    }

    #[test]
    fn a_file_may_be_attached_at_every_level_and_is_required_at_none() {
        let r = dispatch(&json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }));
        let Dispatch::Reply(v) = r else { panic!("expected a reply") };
        let props = &v["result"]["tools"][0]["inputSchema"]["properties"];

        // Everywhere a design can go, for the reason stated over `file_schema`:
        // a call may compare three renders exactly as it compares three
        // mock-ups, and may show one screenshot and ask what is wrong with it.
        for site in [
            &props["file"],
            &props["options"]["items"]["properties"]["file"],
            &props["questions"]["items"]["properties"]["file"],
            &props["questions"]["items"]["properties"]["options"]["items"]["properties"]
                ["file"],
        ] {
            assert_eq!(site["type"], "string", "a file is named by its path");
        }

        // And demanded nowhere: almost every ask is a sentence and some
        // buttons, and a mandatory field would refuse all of them at the
        // client. Same argument as `preview`, one field over.
        assert_eq!(props["options"]["items"]["required"], json!(["label"]));
        assert_eq!(props["questions"]["items"]["required"], json!(["question"]));
    }

    #[test]
    fn something_to_look_at_is_a_description() {
        /* The flagship shape of both `preview` and `file`: options labelled A
           and B with the thing to judge them by drawn full size, and no prose
           under either because the prose would be describing what is on the
           screen. Refusing this would point the check at the calls that spend
           the most of the model's context on the user. */
        assert_eq!(
            undescribed(&json!({
                "question": "which of these?",
                "options": [
                    { "label": "A", "preview": { "html": "<i>a</i>" } },
                    { "label": "B", "preview": { "html": "<i>b</i>" } }
                ]
            })),
            0
        );
        assert_eq!(
            undescribed(&json!({
                "question": "which render?",
                "options": [
                    { "label": "A", "file": { "root": "C:/o", "path": "a.png" } },
                    { "label": "B", "file": { "root": "C:/o", "path": "b.png" } }
                ]
            })),
            0
        );
        /* One of each is still a call where every option shows you something. */
        assert_eq!(
            undescribed(&json!({
                "question": "now, or as it would be?",
                "options": [
                    { "label": "now", "file": "a.png" },
                    { "label": "after", "preview": { "html": "<i>b</i>" } }
                ]
            })),
            0
        );
        /* And the field written out and left blank is no picture at all, which
           is the shape `attach_at` leaves behind when it is given one. */
        assert_eq!(
            undescribed(&json!({
                "question": "which?",
                "options": [
                    { "label": "A", "file": null },
                    { "label": "B", "file": null }
                ]
            })),
            1
        );
    }

    #[test]
    fn an_attachment_is_found_wherever_it_is_hung() {
        /* What the chat-card gate is asked, and therefore what it must not
           miss. A walk that checked three of the four sites would be a gate
           with a hole at the fourth, and the fourth is an option inside
           `questions[]` — which is the form the schema pushes callers toward. */
        assert!(has_file(&json!({ "question": "?", "file": "a.png" })));
        assert!(has_file(&json!({
            "question": "?", "options": [{ "label": "a", "file": "a.png" }]
        })));
        assert!(has_file(&json!({ "questions": [{ "question": "?", "file": "a.png" }] })));
        assert!(has_file(&json!({
            "questions": [{ "question": "?", "options": [{ "label": "a", "file": "a.png" }] }]
        })));

        // And is not seen where there is none, including the shape an agent
        // writes when it means "no file".
        assert!(!has_file(&json!({ "question": "?" })));
        assert!(!has_file(&json!({ "question": "?", "file": null })));
        assert!(!has_file(&json!({
            "questions": [{ "question": "?", "options": [{ "label": "a" }] }]
        })));
        assert!(!has_file(&json!({ "question": "?", "preview": { "html": "<i>x</i>" } })));
    }

    #[test]
    fn the_schema_names_no_file_format_anywhere() {
        /* The whole arrangement, asserted rather than trusted: `drawnAs` in
           `finding.ts` is the one table that decides a reading, and a list of
           extensions here would be a second place to be wrong about a format.
           The description talks about *kinds* of document on purpose — "a
           PDF", "a spreadsheet" — which is prose for the model and not a rule
           anything is matched against. */
        let r = dispatch(&json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }));
        let Dispatch::Reply(v) = r else { panic!("expected a reply") };
        let said = v["result"]["tools"][0].to_string();
        for ext in [".png", ".pdf", ".docx", ".xlsx", ".md", ".csv", ".webp"] {
            assert!(!said.contains(ext), "the schema spells out {ext}");
        }
    }

    #[test]
    fn tools_call_is_parked_rather_than_answered() {
        let r = dispatch(&json!({
            "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": { "name": "ask_user", "arguments": { "question": "tabs or spaces?" } }
        }));
        let Dispatch::Call {
            id, tool, args, ..
        } = r
        else {
            panic!("expected a call")
        };
        assert_eq!(id, 3);
        assert_eq!(tool, "ask_user");
        assert_eq!(args["question"], "tabs or spaces?");
    }

    /// The name is carried through so `start` can route on it. Before the
    /// roster tools existed it was dropped, and every `tools/call` parked on a
    /// question — which is what a `send` would have done: blocked the sending
    /// agent for ten minutes on a panel with nothing in it.
    #[test]
    fn a_call_carries_which_tool_it_meant() {
        let r = dispatch(&json!({
            "jsonrpc": "2.0", "id": 6, "method": "tools/call",
            "params": { "name": "send", "arguments": { "to": "aaaaaaaa", "message": "hi" } }
        }));
        let Dispatch::Call { tool, args, .. } = r else { panic!("expected a call") };
        assert_eq!(tool, crate::relay::SEND_TOOL);
        assert_eq!(args["to"], "aaaaaaaa");
    }

    /// Nothing a card writes reaches a surface carrying a control character,
    /// and the guard is here because this is where arguments stop being wire
    /// and start being a value something will store. Sink `3937d33d`: one item
    /// whose body carried four of them made `sink` answer 178 KB that ripgrep
    /// refused as binary — and, worse, that no reading card could then send.
    ///
    /// Nested, because `paths` is an array and the whole point is that this
    /// does not depend on which field an agent happened to paste into.
    #[test]
    fn a_call_cannot_carry_a_control_character_in_any_of_its_arguments() {
        let r = dispatch(&json!({
            "jsonrpc": "2.0", "id": 9, "method": "tools/call",
            "params": { "name": "drop", "arguments": {
                "title": "tailwind\u{0} fails",
                "body": "&[data-\u{3}\u{13}=\"\u{0}\u{0}\"]",
                "paths": ["src/app\u{0}/page.tsx"],
            } }
        }));
        let Dispatch::Call { args, .. } = r else { panic!("expected a call") };
        assert_eq!(args["title"], "tailwind fails");
        assert_eq!(args["body"], "&[data-=\"\"]");
        assert_eq!(args["paths"][0], "src/app/page.tsx");
    }

    /// And the same on the way back, which is the half that catches text no
    /// write of ours ever saw — a git error or a log line quoted into a
    /// receipt — and the rows that were already in the store.
    #[test]
    fn an_answer_cannot_carry_one_either() {
        let mut body = json!({
            "jsonrpc": "2.0", "id": 1,
            "result": { "content": [{ "type": "text", "text": "one\u{0}item\nkept" }] }
        });
        scrub_json(&mut body);
        assert_eq!(body["result"]["content"][0]["text"], "oneitem\nkept");
    }

    /// What a turn actually pays for, which is no longer the whole roster.
    ///
    /// **This assertion used to measure the wrong thing, and only because the
    /// two were once the same number.** `mcp_config` set `alwaysLoad` on the
    /// server, so every byte of `tools/list` reached every card and the payload
    /// size *was* the standing cost. With the tiering, a deferred tool reaches a
    /// card as its name and nothing else — `formatDeferredToolLine` is
    /// `function iFa(e){ return e.name }`, confirmed verbatim by
    /// `tools/probe-tiers.ts` — so measuring the payload would now count schema
    /// that nobody is charged for, and would go red over tools that are free.
    /// A budget has to be levied on the thing being spent.
    ///
    /// 24KB was a budget and not a measurement: the loaded tier was ~18KB when
    /// this was written, which leaves room for a tool somebody is halfway
    /// through adding and none for pretending nobody notices. Tripping it is
    /// still a conversation rather than a bump — but the conversation is now a
    /// different one, because there is somewhere else to put a tool. The first
    /// question is no longer "do we want this at all", it is **"does a card have
    /// to know this exists without being told?"** If not, it goes in the
    /// deferred tier with a hint and costs ~25 bytes.
    ///
    /// **Raised to 25KB on 2026-09-10, once, deliberately, and by the user.**
    /// `wisp` answered that question with a yes and then missed the old bound by
    /// *one byte*: 21,924 without it, 2,077 for the smallest schema that still
    /// says when not to reach for it, 24,001 together. The whole measurement is
    /// on `chronicle::wisp_schema`. It was raised rather than shaved because a
    /// tier tuned to 23,999 is a build one word from red forever, and rather
    /// than deferred because the feature is *cards writing to the wall's
    /// record* — deferring the write tool would have shipped the feature with
    /// its point removed. The price was quoted before it was agreed: ~520 tokens
    /// on every spawn and every wake, permanently.
    ///
    /// **Raised to 26KB on 2026-09-18, once, deliberately, and by the user.**
    /// Same bar, and a different kind of spend: nothing was added to the roster
    /// at all. `4ff85f3` annotated six already-loaded tools `readOnlyHint`, and
    /// `,"annotations":{"readOnlyHint":true}` is 36 bytes apiece — 216 together,
    /// which took a tier sitting at 24,911 to 25,127. The price was quoted
    /// before it was agreed: ~54 tokens on every spawn and every wake,
    /// permanently.
    ///
    /// What those tokens buy is not a feature but the removal of a lie. Without
    /// the annotation those six tools are *offered* to a planning card,
    /// described to it, and then refused at the moment it reaches — see
    /// `reads_only`, where the probe is. So the question this budget exists to
    /// force — "does a card have to know this exists without being told?" — was
    /// already answered yes for all six, by whoever made them `always`. There
    /// was no deferring available to pay for it, and shaving 127 bytes off a
    /// description would have tuned the tier to ~24,990, which is the thing the
    /// paragraph above says not to build.
    ///
    /// **It was the tag that found this, not a commit.** `cargo test` does not
    /// run on the machine this is developed on (`.claude/rules/build.md`), and
    /// the scheduled build gated out the day between, so `4ff85f3` reached a
    /// release tag before anything had ever compiled it. That is the arrangement
    /// working as designed rather than a miss — but it is worth knowing that the
    /// feedback on a Rust assertion here is a *release*, and to read one that
    /// goes red before assuming the tree is fine.
    ///
    /// That this happened at all is the budget working. What it must not become
    /// is a number that moves whenever it is inconvenient — so the bar for the
    /// next raise is the bar this one met: somebody names the tokens it costs
    /// per spawn, and somebody who pays them says yes.
    ///
    /// **Raised to 32KB on 2026-10-07, once, deliberately, and by the user — and
    /// this time the raise is also a correction.** `ask_user` gained `file`, a
    /// second way to show somebody something: **1,096 bytes, ~275 tokens on
    /// every spawn and every wake, permanently**, measured by building the
    /// loaded tier and stripping the key back out rather than by counting
    /// characters. That took the tier over the 26,000 ceiling; rebased onto the
    /// week's other work it sits at **26,559**, which is 559 over the bound it
    /// replaced and 5,441 under the one it got.
    ///
    /// What happened next is the reason the number moved further than the
    /// 27,000 that would have cleared it. The first response to going red was
    /// to **shorten sentences**, and it worked — in under the bound — and
    /// it quietly cost two things that were doing work, both in the copy paid
    /// three times: the enumeration of what is forbidden at the top level,
    /// which `preview_schema`'s own comment argues for in as many words, and
    /// "only where the decision turns on interaction" on `js`, which is the
    /// sentence sink `51863e1e` exists to have said. Buying them back cost 478
    /// bytes, ~120 tokens, and is the best-value spend in this whole block.
    ///
    /// So the ceiling is now set with **room rather than to the millimetre**,
    /// which is the same argument the 25KB raise made ("a tier tuned to 23,999
    /// is a build one word from red forever") applied to its own consequence: a
    /// bound 215 bytes above the tier does not catch a tool being added
    /// quietly, it catches the next paragraph anybody writes, and what it
    /// extracts is prose rather than a decision. The guard is for tools. See
    /// CLAUDE.md, "a budget is a reason to say a thing once, not a reason to
    /// say less of it", which is the general form and is now stated where every
    /// session reads it.
    ///
    /// The bar is unchanged and this met it: the price was named before it was
    /// agreed, and the person who pays it said raise it.
    const CEILING: usize = 32_000;

    #[test]
    fn the_loaded_tier_is_what_every_turn_pays_for() {
        let loaded: Vec<Value> = roster()
            .into_iter()
            .filter(|t| t["_meta"]["anthropic/alwaysLoad"] == json!(true))
            .collect();
        let bytes = json!(loaded).to_string().len();
        assert!(
            bytes < CEILING,
            "the loaded tier is {bytes} bytes of schema on every spawn of every \
             card, over the {CEILING} this is watching for. In order: is the new \
             tool one every card must know exists without being told — if not it \
             belongs in the deferred tier, and this has done its job. Is the same \
             thing said twice — say it once and point at it, which is what \
             preview_schema does. Otherwise RAISE THIS NUMBER and say why in the \
             commit. Do not thin the prose to get under it: see CLAUDE.md, \
             \"a budget is a reason to say a thing once\"."
        );
    }

    /* ── a choice with nothing to choose by (sink `b260f62a`) ─────────────── */

    /// The shape actually complained about: a row of bare words.
    #[test]
    fn two_bare_labels_are_refused() {
        let args = json!({
            "question": "how should the drafts land?",
            "options": [{ "label": "land all" }, { "label": "I'll read them first" }]
        });
        assert_eq!(undescribed(&args), 1);
    }

    /// One described option is a judgement about which needed describing, and
    /// that judgement is the model's. The trigger is *none of them*, not *any*.
    #[test]
    fn one_described_option_is_enough_to_pass() {
        let args = json!({
            "question": "how should the drafts land?",
            "options": [
                { "label": "land all", "detail": "pushes to two repos" },
                { "label": "hold" }
            ]
        });
        assert_eq!(undescribed(&args), 0);
    }

    /// A blank `detail` is not a `detail`, or the refusal is one space away
    /// from being satisfied without being answered.
    #[test]
    fn whitespace_is_not_a_description() {
        let args = json!({
            "question": "which?",
            "options": [{ "label": "a", "detail": "   " }, { "label": "b", "detail": "" }]
        });
        assert_eq!(undescribed(&args), 1);
    }

    /// The escape hatches the note promises have to actually work, or an agent
    /// that reads it and complies is refused a second time — which is how a
    /// refusal turns into an agent that stops asking.
    #[test]
    fn a_call_that_needs_no_explaining_still_goes_through() {
        /* No options at all: a free-text question. */
        assert_eq!(undescribed(&json!({ "question": "what should it be called?" })), 0);
        /* One option is not a choice. */
        assert_eq!(
            undescribed(&json!({ "question": "ready?", "options": [{ "label": "go" }] })),
            0
        );
        /* And an empty list is the first case written a second way. */
        assert_eq!(undescribed(&json!({ "question": "well?", "options": [] })), 0);
    }

    /// Both forms, because neither may be `required` — see `tool_schema`. A
    /// check that read only the short form would be the gap rather than the
    /// guard, and the long form is where a review puts its twelve decisions.
    #[test]
    fn the_long_form_is_checked_too_and_counted_per_question() {
        let args = json!({
            "questions": [
                { "header": "a", "question": "a?",
                  "options": [{ "label": "x" }, { "label": "y" }] },
                { "header": "b", "question": "b?",
                  "options": [{ "label": "x", "detail": "costs a rebuild" },
                              { "label": "y", "detail": "costs nothing" }] },
                { "header": "c", "question": "c?",
                  "options": [{ "label": "p" }, { "label": "q" }] }
            ]
        });
        assert_eq!(undescribed(&args), 2);
    }

    /// The note has to say nothing happened, how to fix it, and where the
    /// trade-offs go — an agent told only "add detail" writes four paragraphs
    /// onto four buttons, which the panel cannot draw.
    #[test]
    fn the_refusal_says_what_to_do_instead() {
        let note = undescribed_note(1);
        assert!(note.contains("nothing was done"), "what to do next turns on this");
        assert!(note.contains("not interrupted"), "the user is the cost being saved");
        assert!(note.contains("question body"), "where the trade-offs go");
        assert!(note.contains("recommendation first"));
        assert!(note.contains("one option"), "the escape hatch has to be named");
        assert!(undescribed_note(3).contains("3 questions"));
    }

    /// A tool in the deferred tier and carrying no hint is a tool nobody finds.
    ///
    /// This is the failure the tiering introduces, and it is silent: the tool is
    /// registered, it dispatches, every other test passes, and no agent ever
    /// reaches it. `ToolSearch` matches on the name and on
    /// `_meta["anthropic/searchHint"]`, and a skein tool's name is a single
    /// ordinary word — `touched`, `recall`, `take` — chosen to read well in a
    /// sentence rather than to be searched for.
    ///
    /// Probed as a controlled pair on 2026-08-27 rather than assumed: same
    /// query, same two deferred tools, the hint the only difference. With one,
    /// the tool ranked **first** for a query sharing no token with its name;
    /// without one it did not place in the top five. So the hint is the whole of
    /// whether the second tier is a tier or an oubliette.
    #[test]
    fn every_deferred_tool_can_be_found() {
        for t in roster() {
            if t["_meta"]["anthropic/alwaysLoad"] == json!(true) {
                continue;
            }
            let name = t["name"].as_str().unwrap_or("?");
            let hint = t["_meta"]["anthropic/searchHint"].as_str().unwrap_or("");
            assert!(
                hint.len() > 40,
                "`{name}` is deferred with no usable search hint, so nothing will \
                 find it — give it one in `ask::roster` or load it"
            );
        }
    }

    /// Which tools a planning card may still reach, pinned by name.
    ///
    /// The list is the point rather than the count. Claude Code refuses an MCP
    /// tool to a planning card unless it declares `readOnlyHint`, so this is the
    /// difference between a card that can read the sink it is told to read and
    /// one that is told to read it and then refused — which is what shipped, for
    /// every tool on this server, until 2026-09-16.
    ///
    /// Asserted in **both** directions on purpose. A tool missing from the
    /// read-only list is a capability quietly lost to plan mode and nothing
    /// anywhere would say so; a tool wrongly *in* it is the worse half — a
    /// planning card writing a row, a notice or another card's turn, which is
    /// the one thing the gear exists to prevent.
    #[test]
    fn a_planning_card_may_read_and_may_not_write() {
        /* No tool here changes this wall *because it was called*. `board` and
           `sink` do sweep expired rows on the read path, and `ask_user` spends
           the user's attention; both are argued at `reads_only`, and the rule
           for the next one is stated there. */
        const READS: [&str; 19] = [
            "ask_user",
            "board",
            "sink",
            "sink_read",
            "list",
            "allowance",
            "accounts",
            "servers",
            "chronicle",
            "claude_status",
            "touched",
            "recall",
            "pinned",
            "server_log",
            "pipelines",
            "reviews",
            "tasks",
            "records",
            "timeline",
        ];

        let mut seen: Vec<String> = vec![];
        for t in roster() {
            let name = t["name"].as_str().expect("every tool is named").to_string();
            let reads = t["annotations"]["readOnlyHint"] == json!(true);
            if reads {
                assert!(
                    READS.contains(&name.as_str()),
                    "`{name}` says it only reads, so a planning card can call it —                      if that is right, add it to READS here and say why at                      `reads_only`; if it writes anything, take the annotation off"
                );
                seen.push(name);
            } else {
                assert!(
                    !READS.contains(&name.as_str()),
                    "`{name}` is meant to be readable from a planning card and                      carries no `readOnlyHint`, so plan mode refuses it — wrap it                      in `reads_only` in `roster`"
                );
            }
        }

        let mut want: Vec<String> = READS.iter().map(|s| s.to_string()).collect();
        want.sort();
        seen.sort();
        assert_eq!(seen, want, "READS names a tool this server does not advertise");
    }

    /// Absent, not `false`, and the difference is the whole feature.
    ///
    /// The client takes the union of the two flags, so a server-level
    /// `alwaysLoad` would win over every per-tool decision below it and quietly
    /// put the roster back to costing all of itself — with every test here still
    /// green, because the tiers would all still be *declared*. Nothing else
    /// would say so.
    #[test]
    fn the_server_claims_no_tier_of_its_own() {
        let cfg = mcp_config(1234, "abc", None);
        let server = &cfg["mcpServers"]["skein"];
        assert!(
            server.get("alwaysLoad").is_none(),
            "mcp_config set alwaysLoad — that exempts the whole server and \
             `ask::roster`'s tiering stops meaning anything"
        );
    }

    /// The token the keep-alives are addressed to, or nothing to address them
    /// to. `_meta` is protocol rather than arguments, which is why this is the
    /// one thing read out of the params beside the name.
    #[test]
    fn a_call_carries_the_clients_progress_token() {
        let with = dispatch(&json!({
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": { "name": "ask_user", "arguments": {}, "_meta": { "progressToken": 2 } }
        }));
        let Dispatch::Call { progress, .. } = with else { panic!("expected a call") };
        assert_eq!(progress, Some(json!(2)));

        let without = dispatch(&json!({
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": { "name": "ask_user", "arguments": {} }
        }));
        let Dispatch::Call { progress, .. } = without else { panic!("expected a call") };
        assert_eq!(progress, None);

        /* An explicit null is a client saying it wants no progress, which is
           not the same value as the number 0 and must not become one. */
        let nulled = dispatch(&json!({
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": { "name": "ask_user", "_meta": { "progressToken": null } }
        }));
        let Dispatch::Call { progress, .. } = nulled else { panic!("expected a call") };
        assert_eq!(progress, None);
    }

    /// One event, one `data:` line, one blank line to end it — and the whole
    /// park depends on it, because a keep-alive the client's parser cannot
    /// frame is a keep-alive that resets nothing. The hazard is not theoretical:
    /// `to_string` is compact and `to_string_pretty` is one letter away, and the
    /// newlines it would put inside the JSON would end the event early.
    #[test]
    fn one_event_is_one_data_line_and_a_blank_line() {
        let e = sse(&json!({ "jsonrpc": "2.0", "id": 3, "result": { "content": [] } }));
        assert!(e.starts_with("event: message\ndata: "));
        assert!(e.ends_with("\n\n"));
        assert_eq!(e.trim_end_matches('\n').lines().count(), 2);
    }

    /// A chunk says its own length, in hex, and both halves are CRLF-framed —
    /// get either wrong and the client discards the body without a word.
    #[test]
    fn a_chunk_declares_its_length_in_hex() {
        let mut out: Vec<u8> = Vec::new();
        chunk(&mut out, ": waiting\n\n").expect("write to a vec");
        assert_eq!(String::from_utf8(out).unwrap(), "b\r\n: waiting\n\n\r\n");
    }

    /// A call naming no tool is a client we do not understand, and defaulting
    /// it to `ask_user` would park it on a question nobody asked.
    #[test]
    fn a_call_naming_no_tool_names_none() {
        let r = dispatch(&json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/call" }));
        let Dispatch::Call { tool, .. } = r else { panic!("expected a call") };
        assert_eq!(tool, "");
    }

    /// Every one of them, or an agent is told about a capability it cannot
    /// call — so what is asserted is that `tools/list` hands `roster()` back
    /// *whole*, in its own order, with the two tiers not interleaved.
    ///
    /// **This assertion used to spell the roster out as a flat `vec!`, and that
    /// is the interesting part.** Written that way it had already gone stale
    /// once — the forge's three were registered without a line here — and it
    /// went on *compiling*, because a `vec!` missing three elements is
    /// perfectly good Rust. It was repaired by hand, and then it rotted a
    /// second time and harder: the tiering split the roster into a loaded group
    /// and a discoverable one, which moved `list`, `send`, `take`, `done`,
    /// `touched` and `recall` past each other, and the hand-written order said
    /// nothing about it. `cargo test` cannot run on the machine this is written
    /// on (0xC0000139 — see `.claude/rules/build.md`), so the first thing that
    /// could say so was the release workflow, which it failed.
    ///
    /// Twice is the argument. **An exhaustive assertion in a suite that cannot
    /// be executed is documentation, not a guard**, and one restated by hand is
    /// a second copy of the roster that no compiler keeps honest — it fails the
    /// release rather than the change, and it fails it for tidiness rather than
    /// for a defect. So the expectation is derived, as
    /// `every_deferred_tool_can_be_found` and
    /// `the_loaded_tier_is_what_every_turn_pays_for` already derive theirs,
    /// which is why neither of those could rot either time. What is left is the
    /// part a handler can genuinely get wrong: filtering the roster, paging it,
    /// sorting it, or — the one a new tool can cause by being appended in the
    /// wrong place — putting a loaded tool below a deferred one, which reads to
    /// the client as the cheap tier ending earlier than it does.
    #[test]
    fn the_roster_tools_are_advertised_beside_the_question() {
        let r = dispatch(&json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }));
        let Dispatch::Reply(v) = r else { panic!("expected a reply") };
        let names: Vec<String> = v["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_string())
            .collect();
        let expected: Vec<String> = roster()
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(
            names, expected,
            "tools/list is not `ask::roster` whole and in order"
        );

        // The question itself leads, since it is the one every card is told
        // about by name in the paragraph it pays for on every spawn.
        assert_eq!(names.first().map(String::as_str), Some("ask_user"));

        // The tiers are contiguous: everything `always` before everything
        // `found_by`.
        let loaded: Vec<bool> = roster()
            .iter()
            .map(|t| t["_meta"]["anthropic/alwaysLoad"] == json!(true))
            .collect();
        let split = loaded.iter().position(|l| !l).unwrap_or(loaded.len());
        for (i, l) in loaded.iter().enumerate().skip(split) {
            assert!(
                !l,
                "`{}` is always-loaded but sits below the deferred tier, which \
                 starts at `{}` — keep the two groups in `ask::roster` contiguous",
                names[i], names[split]
            );
        }
    }

    /// The two that read come before the one that runs things, and that is not
    /// tidiness — it is the same order the descriptions argue for. A model
    /// scanning this roster meets `servers` and `server_log` first and is told
    /// by both that they cost nothing; by the time it reaches `server` it has
    /// already been offered the cheaper question twice.
    #[test]
    fn reading_the_dev_servers_is_offered_before_running_them() {
        let r = dispatch(&json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }));
        let Dispatch::Reply(v) = r else { panic!("expected a reply") };
        let names: Vec<&str> = v["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        let at = |n: &str| names.iter().position(|x| *x == n).expect("tool is advertised");
        assert!(at(crate::servers::SERVERS_TOOL) < at(crate::servers::SERVER_TOOL));
        assert!(at(crate::servers::SERVER_LOG_TOOL) < at(crate::servers::SERVER_TOOL));
    }

    /// Which tier each of the three dev-server tools is in, and why — because
    /// the reason is the whole finding and it is invisible from the code.
    ///
    /// A card launched a backend and Metro by hand through Bash with both
    /// already defined on the wall, autostarted, and running; then, having no
    /// server log, probed the wedged one over HTTP three times onto a queue the
    /// user was already waiting on (sink `11365b64`). It never called `servers`.
    /// The search hint it had would have ranked first if it had searched, which
    /// is the point: **the failure was not searching**, and that is the one
    /// failure a deferred tool cannot fix about itself.
    ///
    /// So `servers` is loaded — the free read, the call that has to come first
    /// anyway — and the other two stay deferred, named in full by `servers`' own
    /// *answer*, which is a tool result and costs nothing per turn.
    #[test]
    fn the_free_dev_server_read_is_loaded_and_the_two_that_act_are_not() {
        let loaded: Vec<String> = roster()
            .into_iter()
            .filter(|t| t["_meta"]["anthropic/alwaysLoad"] == json!(true))
            .map(|t| t["name"].as_str().unwrap().to_string())
            .collect();
        assert!(
            loaded.iter().any(|n| n == crate::servers::SERVERS_TOOL),
            "the reflex is reached by the loaded tier or not at all: {loaded:?}"
        );
        for acting in [crate::servers::SERVER_TOOL, crate::servers::SERVER_LOG_TOOL] {
            assert!(
                !loaded.iter().any(|n| n == acting),
                "{acting} would take the tier to roughly 800 bytes of slack"
            );
        }
        /* And the promotion is worth nothing unless the description carries the
           instruction — a loaded schema that only names its arguments is 939
           bytes on every turn of every card for a tool nobody reads. */
        let said = crate::servers::servers_schema()["description"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(said.contains("before starting a dev server"), "{said}");
    }

    /// The one tool on this server that starts a process says so where the
    /// model will read it, rather than leaving it to be inferred from a verb.
    ///
    /// Asserted rather than trusted to review, because the whole of "reading is
    /// free, acting is not" lives in these descriptions, and this one is
    /// *deferred* — so it is read by an agent that has already gone looking for
    /// something that starts a server, which is exactly when the warning has to
    /// be there. A
    /// description edited down to name its arguments would take the warning off
    /// the one tool here that can bind a port, and nothing else would notice.
    #[test]
    fn the_tool_that_runs_things_says_that_it_runs_things() {
        let s = crate::servers::server_schema();
        let said = s["description"].as_str().unwrap();
        assert!(said.contains("runs processes on the"), "got: {said}");
        for free in [
            crate::servers::servers_schema(),
            crate::servers::server_log_schema(),
        ] {
            /* Folded, because the two spellings that matter are both
               sentence-initial — `servers` opens the clause with "Costs
               nobody anything", `server_log` with "Free, and it is what to do
               *instead* of". Matched case-sensitively this asserted that a
               description said it was free *and started the sentence in the
               right place*, so it failed the release on a capital letter. */
            let said = free["description"].as_str().unwrap();
            let flat = said.to_lowercase();
            assert!(
                flat.contains("cost") || flat.contains("free"),
                "a reading tool must say it is free — got: {said}"
            );
        }
    }

    /// The arguments reach the front end whole. Rust reads nothing out of them,
    /// so a question shape added in `asking.ts` needs no change here.
    #[test]
    fn several_questions_survive_the_dispatch_untouched() {
        let r = dispatch(&json!({
            "jsonrpc": "2.0", "id": 5, "method": "tools/call",
            "params": { "name": "ask_user", "arguments": { "questions": [
                { "header": "shape", "question": "one widget or two?" },
                { "header": "attention", "question": "ring when it finishes?" }
            ] } }
        }));
        let Dispatch::Call { args, .. } = r else { panic!("expected a call") };
        assert_eq!(args["questions"].as_array().unwrap().len(), 2);
        assert_eq!(args["questions"][1]["header"], "attention");
    }

    /// What `ask_user` declares, for the assertions below. Written out rather
    /// than read off `tool_schema()` so the whole of this group lifts — see
    /// `tools/lift-ask.ts`; the wiring to the real roster is asserted once, on
    /// its own, in `the_check_reads_the_tools_own_schema`.
    const ASK_ARGS: &[&str] = &["questions", "question", "options", "preview", "file"];

    /// The reported call, reconstructed: `options` written as a bare tag, so the
    /// whole of it arrived concatenated onto `question` and no `options` came at
    /// all. The failure is silent at both ends — the call succeeds and returns
    /// an answer — which is why it has to be caught rather than warned about.
    #[test]
    fn an_argument_that_arrived_inside_another_one_is_found() {
        let args = json!({
            "question": "one widget or two?</question> \
                         <parameter name=\"options\">[{\"label\": \"one\"}]"
        });
        assert_eq!(
            swallowed(&args, ASK_ARGS),
            Some(Swallowed { lost: "options".into(), inside: "question".into() })
        );
    }

    /// Both halves of the signature are load-bearing, and this is the second:
    /// pass the argument the text names and the call goes through. That is the
    /// escape hatch for a card writing *about* the syntax — including the one
    /// that filed the bug — and it is why this can be a refusal at all.
    #[test]
    fn quoting_the_syntax_is_allowed_when_the_argument_is_also_passed() {
        let args = json!({
            "question": "should a bare <parameter name=\"options\"> be refused?",
            "options": [{ "label": "yes" }]
        });
        assert_eq!(swallowed(&args, ASK_ARGS), None);
    }

    /// The first half: a tag naming something this tool has no argument for is
    /// somebody else's XML, and none of our business.
    #[test]
    fn a_tag_naming_no_argument_of_this_tool_is_left_alone() {
        let args = json!({
            "question": "why does <parameter name=\"stroke-width\"> not render?"
        });
        assert_eq!(swallowed(&args, ASK_ARGS), None);
    }

    /// It reaches into nested strings, because `questions[]` is where a
    /// multi-decision ask puts its text and the same mis-write lands there.
    #[test]
    fn an_argument_lost_inside_a_nested_question_is_found_too() {
        let args = json!({
            "questions": [
                { "header": "shape", "question": "one or two?" },
                { "question": "ring when done?</question> \
                               <parameter name=\"preview\">{}" }
            ]
        });
        assert_eq!(
            swallowed(&args, ASK_ARGS),
            Some(Swallowed { lost: "preview".into(), inside: "questions".into() })
        );
    }

    /// A half-written tag is not a declaration, and must not take the whole
    /// scan with it — `declarations` walks a string by hand, so an unterminated
    /// quote at the end is the one input that could spin or panic.
    #[test]
    fn a_tag_that_never_closes_names_nothing() {
        assert!(declarations("<parameter name=\"options").is_empty());
        assert!(declarations("<parameter name=").is_empty());
        assert!(declarations("<parameter naming=\"options\">").is_empty());
        assert_eq!(declarations("<parameter name='options'>"), vec!["options"]);
    }

    /// Every well-formed call ever made takes the cheap arm and never builds the
    /// roster. Asserted because the check is on the path of every tool call on
    /// this server, including the ones in the chain that are already slow.
    #[test]
    fn an_ordinary_call_is_not_examined_at_all() {
        for args in [
            json!({ "question": "one widget or two?", "options": [{ "label": "one" }] }),
            json!({ "title": "a finding", "body": "the tag <a href> is fine" }),
            json!({}),
            json!(null),
        ] {
            let mut texts = Vec::new();
            strings_in(&args, &mut texts);
            assert!(!texts.iter().any(|t| t.contains(DECLARATION)), "{args}");
        }
    }

    /// What the agent reads has to be enough to write the call again without
    /// guessing, and has to say first that nothing happened — a refusal that
    /// leaves that in doubt gets a second call to find out.
    #[test]
    fn the_refusal_names_what_was_lost_and_where_it_went() {
        let note = swallowed_note(
            "ask_user",
            &Swallowed { lost: "options".into(), inside: "question".into() },
        );
        assert!(note.contains("nothing was done"), "{note}");
        assert!(note.contains("`options`"), "{note}");
        assert!(note.contains("`question`"), "{note}");
        assert!(note.contains("pass `options` as well"), "{note}");
    }

    /// The one assertion above that cannot be lifted, and the one that would go
    /// quiet on its own: everything else supplies its own list of argument
    /// names, so a tool renaming `options` would leave them all green over a
    /// check that had stopped matching anything. This reads the live roster.
    #[test]
    fn the_check_reads_the_tools_own_schema() {
        let args = json!({
            "question": "one widget or two?</question> \
                         <parameter name=\"options\">[{\"label\": \"one\"}]"
        });
        assert_eq!(
            swallowed_by("ask_user", &args),
            Some(Swallowed { lost: "options".into(), inside: "question".into() })
        );
        /* And a tool this server does not have is nobody's argument. */
        assert_eq!(swallowed_by("ask_user_maybe", &args), None);
    }

    #[test]
    fn a_call_with_no_arguments_still_parks_rather_than_panicking() {
        let r = dispatch(&json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call" }));
        let Dispatch::Call { args, .. } = r else { panic!("expected a call") };
        assert!(args.is_object());
    }

    #[test]
    fn an_unknown_method_reports_itself_instead_of_going_quiet() {
        let r = dispatch(&json!({ "jsonrpc": "2.0", "id": 9, "method": "resources/list" }));
        assert_eq!(
            r,
            Dispatch::Unknown { id: json!(9), method: "resources/list".into() }
        );
    }

    /// The client must outlast us, or it writes the timeout message instead of
    /// the one above — and at the shipped default (60s, probed against 2.1.232)
    /// it abandons the call long before anybody has finished reading it.
    #[test]
    fn the_client_is_told_to_wait_longer_than_we_do() {
        let ours = ANSWER_MAX.as_millis() as u64;
        assert!(
            client_timeout_ms() > ours,
            "the client would give up first and the user's answer would land nowhere"
        );
        assert!(client_timeout_ms() >= ours + 30_000, "not enough headroom to be sure");
    }

    /* -- how long a call gets ---------------------------------------------
     *
     * THE TABLE BELOW IS ASSERTED TWICE. `test/asking.test.ts` runs the same
     * payloads through `answerWindow` and expects the same seconds, because the
     * panel's countdown and this thread's deadline have to be one number seen
     * from two sides. Change a constant here and that suite goes red, which is
     * the whole point of writing it out rather than deriving it.
     */

    /// A flat window meant one thing for a yes/no and another for a review, and
    /// the review is the one that lost. Five questions with options is where it
    /// actually bit (sink `d2adbf74`).
    #[test]
    fn the_window_grows_with_what_is_being_asked() {
        /* One bare question is exactly what it always was. */
        assert_eq!(
            answer_window(&json!({ "question": "ship it?" })).as_secs(),
            600
        );
        /* One question, three options: barely moved. Nobody spends a quarter of
           an hour on a three-way. */
        assert_eq!(
            answer_window(&json!({
                "question": "ship it?",
                "options": [{"label":"a"},{"label":"b"},{"label":"c"}]
            }))
            .as_secs(),
            660
        );
        /* The reported call: five questions, three or four options each,
           seventeen options between them. Ten minutes expired with the user
           still reading; this gives twenty-seven. */
        let five = json!({ "questions": [
            { "question": "one",   "options": [{"label":"a"},{"label":"b"},{"label":"c"},{"label":"d"}] },
            { "question": "two",   "options": [{"label":"a"},{"label":"b"},{"label":"c"},{"label":"d"}] },
            { "question": "three", "options": [{"label":"a"},{"label":"b"},{"label":"c"}] },
            { "question": "four",  "options": [{"label":"a"},{"label":"b"},{"label":"c"}] },
            { "question": "five",  "options": [{"label":"a"},{"label":"b"},{"label":"c"}] },
        ]});
        assert_eq!(answer_window(&five).as_secs(), 600 + 4 * 180 + 17 * 20);

        /* Options are counted because the reading is in them: one decision
           between eight described alternatives is a longer read than four
           yes/nos. */
        let eight: Vec<Value> = (0..8).map(|i| json!({ "label": format!("{i}") })).collect();
        assert_eq!(
            answer_window(&json!({ "question": "which?", "options": eight })).as_secs(),
            760
        );
    }

    /// The counting has to match `normalizeAsk`, or the panel counts down to a
    /// different number from the one this waits for.
    #[test]
    fn the_window_counts_what_the_panel_will_actually_draw() {
        /* An entry with no question is not drawn, so it buys no time — and
           neither do its options. */
        assert_eq!(
            answer_window(&json!({ "questions": [
                { "question": "real",  "options": [{"label":"a"}] },
                { "header": "empty", "options": [{"label":"a"},{"label":"b"}] },
                { "question": "   " }
            ]}))
            .as_secs(),
            620
        );
        /* An option with no label is dropped the same way. */
        assert_eq!(
            answer_window(&json!({
                "question": "which?",
                "options": [{"label":"a"},{"detail":"no label"},{"label":""}]
            }))
            .as_secs(),
            620
        );
        /* The sugar is appended, not preferred: sending both means both. */
        assert_eq!(
            answer_window(&json!({
                "questions": [{ "question": "one" }],
                "question": "two"
            }))
            .as_secs(),
            780
        );
        /* Nothing answerable is still one placeholder question and still parks
           a turn, so it still gets the floor rather than nothing. */
        assert_eq!(answer_window(&json!({})).as_secs(), 600);
        /* And a long list is paid for all the way down, because all of it is
           drawn: nine questions used to buy the time for five (sink
           `4b076830`). The ceiling is the only thing that shortens a call. */
        let many: Vec<Value> = (0..9)
            .map(|i| json!({ "question": format!("q{i}"), "options": [{"label":"a"}] }))
            .collect();
        assert_eq!(
            answer_window(&json!({ "questions": many })).as_secs(),
            600 + 8 * 180 + 9 * 20
        );
    }

    /// The client's deadline is written at spawn and cannot scale with a call it
    /// has not seen, so it is set from the ceiling — and the ceiling has to
    /// actually hold.
    #[test]
    fn no_call_can_ask_for_longer_than_the_client_was_told_to_wait() {
        let everything: Vec<Value> = (0..5)
            .map(|i| {
                let opts: Vec<Value> =
                    (0..40).map(|j| json!({ "label": format!("{i}-{j}") })).collect();
                json!({ "question": format!("q{i}"), "options": opts })
            })
            .collect();
        let w = answer_window(&json!({ "questions": everything }));
        assert_eq!(w, ANSWER_MAX, "the ceiling is reachable and holds");
        assert!(
            client_timeout_ms() > w.as_millis() as u64,
            "ours must fire first, or the client writes the sentence"
        );

        /* And the count alone reaches it now that the count is unbounded, which
           is the one thing that changed when `ANSWER_MAX_QUESTIONS` went: the
           ceiling is what a long call runs into, rather than a truncation. */
        let twenty: Vec<Value> =
            (0..20).map(|i| json!({ "question": format!("q{i}") })).collect();
        assert_eq!(answer_window(&json!({ "questions": twenty })), ANSWER_MAX);
    }

    /// `asking.ts::UNANSWERED` matches this prefix off disk to tell Skein's
    /// sentence from one the user wrote. It may not drift, and what follows it
    /// may — which is the only reason the duration can be in there at all.
    #[test]
    fn the_timeout_sentence_keeps_its_opening_whatever_it_waited() {
        for secs in [600, 1200, 2700] {
            let said = timed_out(Duration::from_secs(secs));
            assert!(said.starts_with(TIMED_OUT_OPENING), "{said}");
            assert!(said.contains(&format!("{} minutes", secs / 60)), "{said}");
            assert!(said.contains("best judgement"), "{said}");
        }
        assert_eq!(TIMED_OUT_OPENING, "The user did not answer in time.");
    }

    /// The hard deadline is an environment variable and the idle one is not, so
    /// the config has to carry the number too — see `mcp_config`.
    #[test]
    fn the_config_carries_the_timeout_the_idle_watchdog_reads() {
        let cfg = mcp_config(51234, "abc-123", None);
        let server = &cfg["mcpServers"]["skein"];
        assert_eq!(server["url"], "http://127.0.0.1:51234/mcp/abc-123");
        assert_eq!(server["timeout"], client_timeout_ms());
        assert!(
            server["timeout"].as_u64().unwrap() > ANSWER_MAX.as_millis() as u64,
            "the idle watchdog would abandon the call before we give up on it"
        );
    }

    #[test]
    fn the_conversation_id_comes_off_the_url() {
        assert_eq!(conversation_of("/mcp/abc-123"), "abc-123");
        assert_eq!(conversation_of("/mcp/abc-123/"), "abc-123");
        assert_eq!(conversation_of("/mcp/abc-123?x=1"), "abc-123");
    }

    /* ── a sheet partway through (sink `fdc6954b`) ─────────────────────── */

    /// What `asking.ts::heldAnswer` pushes for a call of three with one not
    /// reached, in the shape the panel sends it — so a field renamed on
    /// either side is a red test here rather than a hold that silently never
    /// arrives, which is what a misspelled Tauri key does (CLAUDE.md).
    fn a_hold() -> Value {
        json!({
            "said": "Answering each in turn:\n1. Scope: two widgets\n2. Chime: skipped\n\
                     3. Colour: not reached\n\n— skein: a question answered `not reached` …",
            "rest": { "questions": [{ "header": "Colour", "question": "Which colour?", "options": [] }] }
        })
    }

    #[test]
    fn a_hold_arrives_in_the_shape_the_panel_sends_it() {
        let h: Held = serde_json::from_value(a_hold()).expect("the panel's shape");
        assert!(h.said.starts_with("Answering each in turn:"));
        assert_eq!(h.rest.unwrap()["questions"][0]["header"], "Colour");

        /* Every question answered and the send not made: nothing for the pile. */
        let all: Held =
            serde_json::from_value(json!({ "said": "Answering each in turn:\n…", "rest": null }))
                .expect("a full sheet");
        assert!(all.rest.is_none());
    }

    #[test]
    fn a_hold_is_scrubbed_before_an_agent_can_read_it() {
        let h: Held = serde_json::from_value(json!({
            "said": "1. Scope: two\u{0}widgets",
            "rest": { "questions": [{ "question": "Which\u{3} colour?" }] }
        }))
        .unwrap();
        let h = h.scrubbed();
        assert_eq!(h.said, "1. Scope: twowidgets");
        assert_eq!(h.rest.unwrap()["questions"][0]["question"], "Which colour?");
    }

    #[test]
    fn the_hold_going_out_is_recognised_and_a_sent_sheet_is_not() {
        let h: Held = serde_json::from_value(a_hold()).unwrap();
        let note = "The user stopped partway through answering…";

        /* The expiry or the away flip: the hold, then Rust's note on the rest. */
        let reply = format!("{}\n\n{note}", h.said);
        assert_eq!(carried(Some(&h), &reply), Some(true), "rest went to the pile");

        /* The user going back and sending the sheet after all. A hold always
           names what it is short of, so the full sheet cannot open with it. */
        let sent = "Answering each in turn:\n1. Scope: two widgets\n2. Chime: skipped\n3. Colour: red";
        assert_eq!(carried(Some(&h), sent), None);

        /* Nothing held, nothing carried — the ordinary timeout and the plain
           answer are untouched. */
        assert_eq!(carried(None, &reply), None);

        /* A full sheet never sent: carried, with nothing queued. */
        let full = Held { said: "Answering each in turn:\n1. Scope: two widgets".into(), rest: None };
        assert_eq!(carried(Some(&full), &full.said), Some(false));
    }

    /// Going away converts what is parked, and a half-answered sheet has to
    /// travel with its answers — `defer_parked` is the second of the two ways
    /// a call closes without a send, and the one this bug would have survived
    /// in if only the deadline had been fixed.
    #[test]
    fn going_away_takes_the_answers_with_the_question() {
        let asks = Asks::default();
        let (tx, _rx) = mpsc::channel::<String>();
        let held = Arc::new(Mutex::new(Some(serde_json::from_value::<Held>(a_hold()).unwrap())));
        asks.pending.lock().unwrap().insert(
            "q1".into(),
            Parked {
                tx,
                conversation_id: "card".into(),
                args: json!({ "questions": [] }),
                ours: false,
                act: None,
                stirred: Arc::new(Mutex::new(Instant::now())),
                held: Arc::clone(&held),
            },
        );
        let taken = take_parked_questions(&asks);
        assert_eq!(taken.len(), 1);
        let h = taken[0].held.as_ref().expect("the hold travels");
        assert!(h.said.contains("not reached"));
        assert!(h.rest.is_some());
        /* Left in the slot, because the parking thread reads it to recognise
           the reply the flip composes. */
        assert!(held.lock().unwrap().is_some());
    }
}
