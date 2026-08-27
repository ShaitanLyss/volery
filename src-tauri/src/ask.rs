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
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

/// How long a question waits before the agent is told to carry on without you.
///
/// Blocking forever would be worse than it sounds: the turn holds its context,
/// and a question you never noticed becomes an agent wedged until you quit. Ten
/// minutes is long enough to be away from the desk and short enough that a
/// forgotten card unsticks itself.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(600);

const DISMISSED: &str =
    "The user dismissed the question. Proceed using your best judgement.";

const TIMED_OUT: &str =
    "The user did not answer within ten minutes. Proceed using your best \
     judgement, and say which way you went and why.";

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
pub fn client_timeout_ms() -> u64 {
    ANSWER_TIMEOUT.as_millis() as u64 + 60_000
}

/// The `--mcp-config` a card is spawned with: one server, addressed to it.
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
/// **`alwaysLoad` is why an agent knows these tools have descriptions at all.**
/// Tool search is on by default in the CLI and is *not* threshold-gated when
/// `ENABLE_TOOL_SEARCH` is unset — read out of 2.1.235, where unset and `auto`
/// are different modes and only `auto` weighs the definitions against 10% of the
/// window. So without this flag every tool here reaches a card as a bare name
/// behind a `ToolSearch` step, with its schema withheld. That is worse for this
/// server than for most, because everything that makes the billboard work is
/// *in* the descriptions: that reading it is free where a `send` costs the other
/// agent a turn, that a notice wants `paths` on it, that `unpost` is the half
/// nobody else can do for you. None of it was reaching the wall.
///
/// One flag exempts the whole server — the CLI loads every tool from it at
/// session start whatever `ENABLE_TOOL_SEARCH` says, and an exempt tool does not
/// count toward `auto`'s threshold either, so skein does not compete for budget
/// with whatever else the machine has configured. What buys the cost back is
/// that the descriptions are where the reasoning lives, so
/// `supervisor::append_prompt` does not have to carry it.
///
/// **The cost is paid per spawn and is asserted rather than remembered.** The
/// argument for this flag was first made of six tools and ~9KB; the roster has
/// more than doubled since and gains tools faster than this comment gets read,
/// so a number written here would be wrong within the week and would go on
/// sounding authoritative. `the_roster_stays_inside_what_alwaysLoad_costs` holds
/// the ceiling instead. A tool that trips it is not a number to raise — it is
/// the moment to ask whether every tool on this server is wanted on every turn,
/// which is the only claim `alwaysLoad` rests on. Startup then
/// waits on this server, capped at 5s — free here, since it is an HTTP listener
/// on loopback that `Asks::port` has already answered for by the time anything
/// spawns.
///
/// `supervisor::append_prompt` is short *because* of this, and says so: with the
/// descriptions in front of the agent, the one paragraph every card pays for
/// need not restate them. Taking this flag off makes that paragraph the whole of
/// what a card knows about the board.
pub fn mcp_config(port: u16, conversation_id: &str) -> Value {
    json!({
        "mcpServers": {
            "skein": {
                "type": "http",
                "url": format!("http://127.0.0.1:{port}/mcp/{conversation_id}"),
                "timeout": client_timeout_ms(),
                "alwaysLoad": true,
            }
        }
    })
}

#[derive(Default)]
pub struct Asks {
    port: Mutex<u16>,
    pending: Mutex<HashMap<String, Sender<String>>>,
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
}

impl Asks {
    pub fn port(&self) -> u16 {
        *self.port.lock().unwrap()
    }
    pub fn set_port(&self, port: u16) {
        *self.port.lock().unwrap() = port;
    }
}

/// Hand the UI's answer back to the parked HTTP request.
#[tauri::command]
pub fn answer_ask(asks: State<'_, Asks>, ask_id: String, answer: String) -> Result<(), String> {
    let tx = asks
        .pending
        .lock()
        .unwrap()
        .remove(&ask_id)
        .ok_or("that question is no longer waiting")?;
    tx.send(answer).map_err(|_| "the asking turn has gone".to_string())
}

/// A design the user can look at instead of imagine.
///
/// Skein draws this in an isolated frame — see `asking.ts::previewDoc` for what
/// contains it. The description is doing real work: the model has spent its
/// whole life describing layouts in prose to a terminal, and left to itself will
/// keep doing that beside an empty `preview` field.
fn preview_schema() -> Value {
    json!({
        "type": "object",
        "description":
            "Optional. What this looks like, as a small self-contained web page, \
             shown full-size instead of described — side by side with the \
             alternatives when each option carries one, on its own when the \
             question does and you are asking whether it will do. Reach for it \
             when the decision is visual — a layout, a card, a colour treatment, \
             a chart — because a picked design should be one that was seen. It \
             is rendered in a sealed frame: no network, no imports, no \
             frameworks, no external fonts or images (inline SVG and data: URIs \
             are fine). Skein's own design tokens are already defined, so \
             var(--paper), var(--ink), var(--surface), var(--edge), var(--body) \
             and the rest are available and are what to build in. Compose for a \
             1280x800 viewport; it is scaled down to fit.",
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
                     without it."
            }
        },
        "required": ["html"]
    })
}

/// One question's shape, shared by the `questions` array and reused for the
/// single-question sugar so the two cannot drift apart.
fn option_schema() -> Value {
    json!({
        "type": "array",
        "description": "Preset answers for this question, most recommended first.",
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
                        "One short line on what picking this means. Not a paragraph — \
                         this is drawn on a button."
                },
                "preview": preview_schema()
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
             When you have more than one decision outstanding, put each in its own \
             entry of `questions` rather than fusing them into one. They are asked one \
             at a time and answered separately. Fusing two decisions forces the options \
             to be combinations of both — which is longer to read and, worse, silently \
             leaves out the combinations you did not think to list.\n\n\
             When the decision is a visual one, do not describe the designs — give \
             each option a `preview` and they are drawn side by side, full size, for \
             the user to look at and pick from. This client has a real display; a \
             layout written out in prose is a layout being chosen from memory.",
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
                            "preview": preview_schema()
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
                "preview": preview_schema()
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

/// Register a question and put it in front of the user. Returns the id it was
/// filed under and the channel a click comes back on.
fn open_ask(
    app: &AppHandle,
    asks: &Asks,
    conversation_id: &str,
    args: &Value,
    ours: bool,
) -> (String, Receiver<String>) {
    let ask_id = crate::store::uuid_v4();
    let (tx, rx) = mpsc::channel::<String>();
    asks.pending.lock().unwrap().insert(ask_id.clone(), tx);

    let _ = app.emit(
        "ask:opened",
        AskOpened {
            conversation_id: conversation_id.to_string(),
            ask_id: ask_id.clone(),
            ask: args.clone(),
            ours,
        },
    );

    (ask_id, rx)
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
fn park_and_stream(
    app: &AppHandle,
    asks: &Asks,
    conversation_id: &str,
    id: &Value,
    args: &Value,
    progress: Option<Value>,
    req: tiny_http::Request,
    settle: Option<Settle>,
) {
    let (ask_id, rx) = open_ask(app, asks, conversation_id, args, settle.is_some());
    let forget = || {
        asks.pending.lock().unwrap().remove(&ask_id);
    };
    let closed = |answered: bool| {
        let _ = app.emit(
            "ask:closed",
            AskClosed {
                ask_id: ask_id.clone(),
                answered,
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
        closed(false);
        return;
    }

    let started = Instant::now();
    let mut fed: u64 = 0;
    let answer = loop {
        match rx.recv_timeout(FEED_EVERY) {
            Ok(a) => break a,
            /* The sender was dropped — the card was closed while it was
               asking. */
            Err(RecvTimeoutError::Disconnected) => break DISMISSED.to_string(),
            Err(RecvTimeoutError::Timeout) => {
                if started.elapsed() >= ANSWER_TIMEOUT {
                    forget();
                    break TIMED_OUT.to_string();
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
                    closed(false);
                    return;
                }
            }
        }
    };

    let real = answer != TIMED_OUT && answer != DISMISSED;
    /* The settle runs *here*, on the parking thread, after the answer is in and
       before the reply goes out — which is what makes a `close` genuinely
       deferred rather than merely delayed. It is also the last moment at which
       the wall is still current: ten minutes have passed, and the card the user
       was asked about may since have started a turn, been set aside, or gone.
       So `spawn::close` re-reads all of it rather than trusting what it saw
       when it composed the question. */
    let reply = match settle {
        Some(decide) => decide(app, if real { Some(answer.as_str()) } else { None }),
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
    closed(real && delivered);
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
            "result": { "tools": [
                tool_schema(),
                crate::relay::list_schema(),
                crate::relay::send_schema(),
                crate::board::board_schema(),
                crate::board::post_schema(),
                crate::board::unpost_schema(),
                crate::sink::sink_schema(),
                crate::sink::drop_schema(),
                crate::sink::take_schema(),
                crate::sink::done_schema(),
                crate::relay::touched_schema(),
                crate::relay::recall_schema(),
                crate::limits::allowance_schema(),
                crate::later::wake_schema(),
                crate::pin::pin_schema(),
                crate::pin::repin_schema(),
                crate::pin::pinned_schema(),
                crate::spawn::spawn_schema(),
                crate::spawn::close_schema(),
                crate::servers::servers_schema(),
                crate::servers::server_log_schema(),
                crate::servers::server_schema(),
            ] }
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
            args: rpc
                .get("params")
                .and_then(|p| p.get("arguments"))
                .cloned()
                .unwrap_or_else(|| json!({})),
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

fn respond(req: tiny_http::Request, body: Value) {
    let data = body.to_string();
    let header = tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
        .expect("static header");
    let _ = req.respond(tiny_http::Response::from_string(data).with_header(header));
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
                        /* Two tools park, and everything else is answered on
                           this thread and returns in milliseconds, well inside
                           every clock either side of this connection has. Which
                           is also why the roster tools were put on this server
                           rather than beside it — a call that is not a question
                           costs nothing here, and the client already trusts this
                           endpoint. */
                        if tool == "ask_user" {
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
                                    );
                                }
                            }
                            return;
                        }

                        let answer = crate::relay::handle(&app, &conversation_id, &tool, &args)
                            .or_else(|| crate::board::handle(&app, &conversation_id, &tool, &args))
                            .or_else(|| crate::sink::handle(&app, &conversation_id, &tool, &args))
                            .or_else(|| crate::limits::handle(&app, &conversation_id, &tool, &args))
                            .or_else(|| crate::later::handle(&app, &conversation_id, &tool, &args))
                            .or_else(|| crate::pin::handle(&app, &conversation_id, &tool, &args))
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

    /// Every schema on this server, on every spawn of every card, because
    /// `mcp_config` sets `alwaysLoad` — so the roster's total size is a running
    /// cost of having the wall open rather than a cost of using a tool. 40KB is
    /// a budget and not a measurement: it was ~26KB when this was written, which
    /// leaves room for the tools somebody is halfway through adding and none for
    /// pretending nobody notices. Tripping it is a conversation, not a bump.
    #[test]
    fn the_roster_stays_inside_what_always_load_costs() {
        let r = dispatch(&json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }));
        let Dispatch::Reply(v) = r else { panic!("expected a reply") };
        let bytes = v["result"]["tools"].to_string().len();
        assert!(
            bytes < 40_000,
            "the roster is {bytes} bytes of schema on every spawn — see mcp_config"
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
    /// call. Asserted as an ordered list rather than a set, because the order is
    /// the order they reach the model and the cheap ones belong in front of the
    /// one that parks.
    #[test]
    fn the_roster_tools_are_advertised_beside_the_question() {
        let r = dispatch(&json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }));
        let Dispatch::Reply(v) = r else { panic!("expected a reply") };
        let names: Vec<&str> = v["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            vec![
                "ask_user",
                crate::relay::LIST_TOOL,
                crate::relay::SEND_TOOL,
                crate::board::BOARD_TOOL,
                crate::board::POST_TOOL,
                crate::board::UNPOST_TOOL,
                crate::sink::SINK_TOOL,
                crate::sink::DROP_TOOL,
                crate::sink::TAKE_TOOL,
                crate::sink::DONE_TOOL,
                crate::relay::TOUCHED_TOOL,
                crate::relay::RECALL_TOOL,
                crate::limits::ALLOWANCE_TOOL,
                crate::later::WAKE_TOOL,
                crate::pin::PIN_TOOL,
                crate::pin::REPIN_TOOL,
                crate::pin::PINNED_TOOL,
                crate::spawn::SPAWN_TOOL,
                crate::spawn::CLOSE_TOOL,
                crate::servers::SERVERS_TOOL,
                crate::servers::SERVER_LOG_TOOL,
                crate::servers::SERVER_TOOL,
            ]
        );
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

    /// The one tool on this server that starts a process says so where the
    /// model will read it, rather than leaving it to be inferred from a verb.
    ///
    /// Asserted rather than trusted to review, because the whole of "reading is
    /// free, acting is not" lives in these descriptions — `alwaysLoad` is what
    /// buys them, and `append_prompt` is short on the strength of it. A
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
            let said = free["description"].as_str().unwrap();
            assert!(
                said.contains("cost") || said.contains("Free"),
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
        let ours = ANSWER_TIMEOUT.as_millis() as u64;
        assert!(
            client_timeout_ms() > ours,
            "the client would give up first and the user's answer would land nowhere"
        );
        assert!(client_timeout_ms() >= ours + 30_000, "not enough headroom to be sure");
    }

    /// The hard deadline is an environment variable and the idle one is not, so
    /// the config has to carry the number too — see `mcp_config`.
    #[test]
    fn the_config_carries_the_timeout_the_idle_watchdog_reads() {
        let cfg = mcp_config(51234, "abc-123");
        let server = &cfg["mcpServers"]["skein"];
        assert_eq!(server["url"], "http://127.0.0.1:51234/mcp/abc-123");
        assert_eq!(server["timeout"], client_timeout_ms());
        assert!(
            server["timeout"].as_u64().unwrap() > ANSWER_TIMEOUT.as_millis() as u64,
            "the idle watchdog would abandon the call before we give up on it"
        );
    }

    #[test]
    fn the_conversation_id_comes_off_the_url() {
        assert_eq!(conversation_of("/mcp/abc-123"), "abc-123");
        assert_eq!(conversation_of("/mcp/abc-123/"), "abc-123");
        assert_eq!(conversation_of("/mcp/abc-123?x=1"), "abc-123");
    }
}
