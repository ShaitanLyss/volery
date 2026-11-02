//! What a card's context is costing it, and the one thing it can do about that
//! itself.
//!
//! **A card's context is its price per request.** Every request a card makes —
//! every tool call, not only every turn — re-reads the whole conversation, and
//! on this wall that re-reading is most of the bill: measured over 24 hours to
//! 2026-09-14, 85% of the Opus spend was cache reads and writes against 15% of
//! output (sink `ef384c69`). A coordinator held one session for 22 days at a
//! median of 493k tokens, and 64% of its 220M input units were it re-reading
//! itself (sink `71803a3b`). None of that was visible *to the card*: the honest
//! reading existed only in the front end, which folds it for the ring, and the
//! one number that would let an agent decide "this is a good moment to compact"
//! was in nobody's hands but the user's.
//!
//! So this module folds it in Rust, from the same reader thread that already
//! parses every line (`supervisor.rs`, one call), and says it in two places:
//!
//! - **`allowance` grows a line** with the absolute number and what it costs.
//!   Absolute, never a percentage: the percentage needs the window, the window
//!   needs the model-tier inference CLAUDE.md records being got wrong twice, and
//!   "31%" is exactly the reading that makes an expensive card look healthy.
//!   312,000 tokens re-read on every request is the fact; the ratio is a guess
//!   about something else.
//! - **`compact` is a deferred tool** that `allowance`'s answer names in full —
//!   `servers`' argument for `server_log`: a tool result costs nothing per turn,
//!   and the loaded tier has no room.
//!
//! The fold reads the **last `assistant` message's** usage, never `result.usage`
//! — that sums every iteration of a turn and climbs past the window (CLAUDE.md,
//! the first of the load-bearing mistakes). It is the same arithmetic as
//! `conversation.svelte.ts`'s `ctxTokens`, including the output tokens: the last
//! answer is in the next request's input, so it is part of what gets re-read.
//! A compaction produces no assistant message, so its boundary's `post_tokens`
//! is the reading the moment it is true — the front end learned that one too.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::AppHandle;

pub const COMPACT_TOOL: &str = "compact";

/// Exactly the CLI's slash command, and nothing else. A `[skein …]` prefix, a
/// trailing note, a leading space — any of them turns the command back into a
/// sentence the model answers conversationally (probed 2026-09-15 against
/// claude 2.1.266, sink `859c486d`; the first probe failed because Git Bash's
/// MSYS conversion had rewritten it into `C:/Program Files/Git/compact`).
pub const COMPACT_PROMPT: &str = "/compact";

/// Below this there is nothing a compaction buys worth the summary it costs:
/// the CLI's own answer at the bottom end is "Not enough messages to compact",
/// and somewhere above that a summary of a short conversation loses more than
/// it saves. A card at 40k is cheap per request whatever it does.
pub const FLOOR_TOKENS: u64 = 60_000;

/// One compaction per card per this long, counted when it is *delivered*.
///
/// The guard `later.rs`'s `MAX_SERVED` is for wakes, for the same reason: a
/// card in a loop — compact, read the allowance again, see a big number again
/// because the compaction has not run yet, compact again — queues a pile of
/// them behind its own turn, and each one is a model call summarising the
/// summary. Twenty minutes is longer than any compaction takes and shorter than
/// the stretch of work that refills a context worth compacting.
pub const MIN_GAP: Duration = Duration::from_secs(20 * 60);

/// The last reading per card, by conversation id.
///
/// Process memory rather than a column: it is re-established by the first
/// answer after any spawn, it is only ever asked by a card that is mid-turn
/// (and therefore has just produced one), and a row would be written on every
/// assistant message of every card for a number nothing reads at launch.
static CONTEXT: Mutex<Option<HashMap<String, u64>>> = Mutex::new(None);
static COMPACTED: Mutex<Option<HashMap<String, Instant>>> = Mutex::new(None);

/// What one stream event says about the card's context, if anything.
///
/// `None` for every event that is not evidence: a subagent's forwarded message
/// (`parent_tool_use_id` — it is the subagent's context, not this card's), the
/// CLI's own `<synthetic>` messages (all-zero usage — a locally-answered slash
/// command or a refused request, and the front end was bitten by both), and an
/// `assistant` with no usage at all.
pub fn context_of(ev: &Value) -> Option<u64> {
    match ev.get("type").and_then(Value::as_str)? {
        "assistant" => {
            if ev.get("parent_tool_use_id").is_some_and(|p| !p.is_null()) {
                return None;
            }
            let msg = ev.get("message")?;
            if msg.get("model").and_then(Value::as_str) == Some("<synthetic>") {
                return None;
            }
            let u = msg.get("usage")?;
            let n = |k: &str| u.get(k).and_then(Value::as_u64).unwrap_or(0);
            let total = n("input_tokens")
                + n("cache_read_input_tokens")
                + n("cache_creation_input_tokens")
                + n("output_tokens");
            (total > 0).then_some(total)
        }
        "system" if ev.get("subtype").and_then(Value::as_str) == Some("compact_boundary") => {
            let m = ev.get("compact_metadata").or_else(|| ev.get("compactMetadata"))?;
            let post = m
                .get("post_tokens")
                .or_else(|| m.get("postTokens"))
                .and_then(Value::as_u64)?;
            (post > 0).then_some(post)
        }
        _ => None,
    }
}

/// The reader thread's one call. Cheap on every event that is not one of the
/// two above, which is nearly all of them (`stream_event` outnumbers the rest).
pub fn fold(id: &str, ev: &Value) {
    if let Some(tokens) = context_of(ev) {
        if let Ok(mut map) = CONTEXT.lock() {
            map.get_or_insert_with(HashMap::new).insert(id.to_string(), tokens);
        }
    }
}

/// The last reading for a card, if its process has answered anything yet.
pub fn tokens_of(id: &str) -> Option<u64> {
    CONTEXT.lock().ok()?.as_ref()?.get(id).copied()
}

/// Grouped by thousands, the way a person reads a price.
fn grouped(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// The line `allowance` ends with. Pure, so the wording is tested.
///
/// It names `compact` in full and says when *not* to reach for it, because the
/// bad use is cheap to make: a compaction is a model call, it loses detail, and
/// a card mid-way through a careful piece of work loses exactly the detail it
/// is working from. The good moment is a boundary — a round finished, a report
/// sent, a long investigation concluded into a file — which is a judgement the
/// card is better placed to make than any threshold, and the user explicitly
/// wanted it to stay a judgement rather than `--autocompact` (sink `859c486d`).
pub fn context_line(tokens: Option<u64>) -> String {
    let Some(t) = tokens else {
        return "This card's own context size has not been read yet — its process has not \
                answered since it last started."
            .into();
    };
    let size = grouped(t);
    if t < FLOOR_TOKENS {
        return format!(
            "This card's context is {size} tokens. Every request it makes — each tool call, \
             not only each turn — re-reads all of it, and at this size that is cheap."
        );
    }
    format!(
        "This card's context is {size} tokens, and every request it makes — each tool call, \
         not only each turn — re-reads all of it: that size *is* this card's price per \
         request, and on this wall re-reading context is most of the bill. If much of it is \
         finished work you no longer need verbatim, `mcp__skein__compact` folds the \
         conversation into a summary after this turn ends. Use it at a boundary — a round \
         done, a report sent, findings written to a file — not in the middle of work whose \
         detail you are still using; and anything you must keep exactly (paths, ids, the \
         handles of cards you coordinate) belongs in a file or your last message first."
    )
}

pub fn compact_schema() -> Value {
    serde_json::json!({
        "name": COMPACT_TOOL,
        "description":
            "Compact this card's own conversation: Claude Code's `/compact`, queued behind the \
             turn you are in, folds everything so far into a summary so every later request \
             re-reads far less. It does **not** happen during this call — it runs once this \
             turn ends, and your next turn starts from the summary.\n\n\
             Worth it when the context is large and mostly finished work — `allowance` says \
             how large. Before calling it, put anything that must survive exactly (file paths, \
             ids, decisions, the handles of cards you are coordinating) in a file or in what \
             you say before ending the turn, since the summary keeps the gist, not the \
             detail. Refused below a size where it buys nothing, and more than once in twenty \
             minutes.",
        "inputSchema": { "type": "object", "properties": {} }
    })
}

/// Why a compaction would not be queued now, or `None` if it may. Pure: the
/// wall's state is passed in, so the guard is tested without a process.
fn refusal(tokens: Option<u64>, since_last: Option<Duration>) -> Option<String> {
    if let Some(t) = tokens.filter(|t| *t < FLOOR_TOKENS) {
        return Some(format!(
            "Not queued: this card's context is {} tokens, and below {} a compaction loses \
             detail without saving anything worth having. Nothing was changed.",
            grouped(t),
            grouped(FLOOR_TOKENS)
        ));
    }
    if let Some(ago) = since_last.filter(|a| *a < MIN_GAP) {
        let wait = (MIN_GAP - ago).as_secs().div_ceil(60);
        return Some(format!(
            "Not queued: a compaction was already sent to this card {} minute(s) ago, and \
             one that is still waiting behind this turn would compact the same conversation \
             twice. Nothing was changed; it can be asked again in about {wait} minute(s).",
            ago.as_secs() / 60
        ));
    }
    None
}

fn do_compact(app: &AppHandle, caller: &str) -> String {
    let tokens = tokens_of(caller);
    let since = COMPACTED
        .lock()
        .ok()
        .and_then(|m| m.as_ref()?.get(caller).map(|at| at.elapsed()));
    if let Some(why) = refusal(tokens, since) {
        return why;
    }
    match crate::supervisor::deliver(app, caller, COMPACT_PROMPT) {
        Ok(()) => {
            /* Counted on delivery, and only on delivery: a send that never left
               has compacted nothing, and charging it would refuse the retry. */
            if let Ok(mut m) = COMPACTED.lock() {
                m.get_or_insert_with(HashMap::new).insert(caller.to_string(), Instant::now());
            }
            let from = tokens.map(|t| format!(" from {} tokens", grouped(t))).unwrap_or_default();
            format!(
                "Queued `/compact`{from}. It has not happened yet: Claude Code runs it once \
                 this turn ends, and your next turn begins from the summary. Finish what you \
                 were saying and end the turn — anything that must survive exactly should be \
                 in a file or in this turn's last message, because the summary keeps the gist."
            )
        }
        Err(e) => format!("Not queued — the card's process could not be written to: {e}"),
    }
}

/// Route a `tools/call` that belongs to this file; `None` for any other name.
pub fn handle(app: &AppHandle, caller: &str, tool: &str, _args: &Value) -> Option<String> {
    (tool == COMPACT_TOOL).then(|| do_compact(app, caller))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_last_assistant_message_is_the_reading() {
        let ev = json!({ "type": "assistant", "message": { "model": "claude-opus-5-5",
            "usage": { "input_tokens": 3, "cache_read_input_tokens": 300_000,
                       "cache_creation_input_tokens": 1_200, "output_tokens": 500 } } });
        assert_eq!(context_of(&ev), Some(301_703));
    }

    #[test]
    fn a_result_is_never_the_reading() {
        /* `result.usage` sums every iteration of a turn: CLAUDE.md's first
           load-bearing mistake, held here as a test rather than a comment. */
        let ev = json!({ "type": "result", "usage": { "input_tokens": 10,
            "cache_read_input_tokens": 900_000 } });
        assert_eq!(context_of(&ev), None);
    }

    #[test]
    fn a_subagent_or_a_synthetic_message_is_not_this_cards_context() {
        let sub = json!({ "type": "assistant", "parent_tool_use_id": "toolu_1",
            "message": { "usage": { "cache_read_input_tokens": 40_000 } } });
        assert_eq!(context_of(&sub), None);
        let synthetic = json!({ "type": "assistant", "message": { "model": "<synthetic>",
            "usage": { "input_tokens": 0 } } });
        assert_eq!(context_of(&synthetic), None);
        let top = json!({ "type": "assistant", "parent_tool_use_id": null,
            "message": { "usage": { "cache_read_input_tokens": 40_000 } } });
        assert_eq!(context_of(&top), Some(40_000));
    }

    #[test]
    fn a_compaction_is_read_at_its_boundary() {
        let ev = json!({ "type": "system", "subtype": "compact_boundary",
            "compact_metadata": { "trigger": "manual", "pre_tokens": 480_000, "post_tokens": 21_000 } });
        assert_eq!(context_of(&ev), Some(21_000));
        let empty = json!({ "type": "system", "subtype": "compact_boundary", "compact_metadata": {} });
        assert_eq!(context_of(&empty), None);
    }

    #[test]
    fn the_fold_keeps_the_newest_per_card() {
        let id = "test-fold-card";
        fold(id, &json!({ "type": "assistant", "message": { "usage": { "input_tokens": 100 } } }));
        fold(id, &json!({ "type": "stream_event" }));
        fold(id, &json!({ "type": "assistant", "message": { "usage": { "input_tokens": 250 } } }));
        assert_eq!(tokens_of(id), Some(250));
        assert_eq!(tokens_of("nobody"), None);
    }

    #[test]
    fn the_line_says_a_number_not_a_ratio_and_names_the_tool() {
        let big = context_line(Some(480_123));
        assert!(big.contains("480,123 tokens"), "{big}");
        assert!(big.contains("mcp__skein__compact"));
        assert!(!big.contains('%'), "an absolute size, never a percentage: {big}");
        let small = context_line(Some(12_000));
        assert!(small.contains("12,000"));
        assert!(!small.contains("compact"), "nothing to suggest at this size: {small}");
        assert!(context_line(None).contains("not been read yet"));
    }

    #[test]
    fn the_prompt_is_exactly_the_slash_command() {
        assert_eq!(COMPACT_PROMPT, "/compact");
    }

    #[test]
    fn the_guard_refuses_small_and_repeated_and_lets_the_rest_through() {
        assert!(refusal(Some(30_000), None).unwrap().contains("Nothing was changed"));
        assert!(refusal(Some(500_000), Some(Duration::from_secs(60))).unwrap().contains("19 minute"));
        assert_eq!(refusal(Some(500_000), Some(MIN_GAP)), None);
        assert_eq!(refusal(Some(500_000), None), None);
        /* No reading yet is not a reason to refuse: the card asking has just
           answered something, and a missing number is a gap in our fold. */
        assert_eq!(refusal(None, None), None);
    }

    #[test]
    fn grouping_reads_like_a_price() {
        assert_eq!(grouped(0), "0");
        assert_eq!(grouped(999), "999");
        assert_eq!(grouped(1_000), "1,000");
        assert_eq!(grouped(1_234_567), "1,234,567");
    }
}
