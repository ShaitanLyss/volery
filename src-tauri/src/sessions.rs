//! What Claude Code has already recorded, for conversations Skein never opened.
//!
//! A session started in the terminal is a `.jsonl` under
//! `~/.claude/projects/<slug>/`, and Skein can adopt one by doing nothing more
//! than writing a row that points at it: nothing is copied, nothing moves, and
//! the file stays the shared surface both front ends append to.
//!
//! Two things about this walk are deliberate.
//!
//! **Identity comes from inside the file, never from the directory name.** The
//! slug folds every non-alphanumeric character to a dash (see
//! `supervisor::transcript_dir_name`), so `.scratch` and `-scratch` land in the
//! same place and no decoding can tell them apart. Every record carries its own
//! `cwd` — 97 of 97 transcripts here — so the catalogue reads that instead.
//!
//! **Almost no line is parsed as JSON.** The 503 transcripts on this machine
//! are 870 MB and the largest is tens of megabytes, nearly all of it tool
//! results nobody is listing. The last `ai-title` and the last `assistant`
//! record are carried forward as text and parsed once the file is done; the
//! only other parse is `prompt_of`, asked of `user` records until one answers
//! and then not again.
//!
//! **And a name comes from three places, in order.** Most transcripts have no
//! `ai-title` in them at all — 316 of the 503 here — so a panel that read only
//! that offered most of the wall's own history back as `untitled`, including a
//! card closed by accident whose name was in the `conversation` table the whole
//! time. `settle_titles` is where the three sources are put in order, and it is
//! the one thing in this module that reads the database twice over.
//!
//! **A session is reported where its records say it was, unchanged.** Under a
//! junction that is the resolved path, and it once differed from the spelling
//! the `project` row held, so adopting one gave the wall a second territory for
//! the same repository; `settle_roots` rewrote it here to close that. Roots are
//! now stored resolved and `ensure_project` resolves what it is handed
//! (`store::canonical_root`), which settles every spelling at the one door a
//! territory comes through, so this module no longer has to.
//!
//! **And only the head and the tail of each file are read at all**, which this
//! module claimed for a year while its loop went through every line of all
//! 167 MB — `field` scanning a multi-megabyte tool result seven times over to
//! learn a timestamp that was never on it. The panel that shows this list came
//! up empty for long enough that you would start typing in the filter, which is
//! how it was found. See `HEAD` and `TAIL` for what is read instead and the
//! measurement that sized them.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// A conversation on disk that no card points at yet.
#[derive(Serialize)]
pub struct Session {
    /// The session id, which is the filename — and what `--resume` takes.
    id: String,
    /// Where the session was, as its records say. Adopting it resolves this
    /// through `ensure_project`, so another spelling of a territory's folder
    /// still lands in that territory.
    cwd: String,
    branch: Option<String>,
    /// What the row is called: the transcript's own `ai-title`, or — resolved
    /// by `settle_titles`, which is the only place the three sources are put in
    /// order — the wall's name for this session, or its first prompt.
    title: Option<String>,
    /// The first thing anybody said, clipped. Kept beside the title rather than
    /// folded into it because the two answer different questions: the title is
    /// what the row *reads*, and this is text the filter can find it by even
    /// when the row is reading something else.
    prompt: Option<String>,
    /// The bare API name from the last answered message. It carries no window
    /// tier — see the note in `list_sessions`.
    model: Option<String>,
    /// What the last request actually occupied. Left as tokens rather than a
    /// fraction because the front end owns the window arithmetic.
    ctx_tokens: u64,
    /// ISO timestamps, exactly as recorded.
    born_at: Option<String>,
    last_at: Option<String>,
    bytes: u64,
}

/// Pull `"key":"value"` out of a line without parsing it.
///
/// Only used for fields whose values are plain ISO strings or paths — the point
/// is to avoid deserialising megabytes of tool output to learn a timestamp.
fn field(line: &str, key: &str) -> Option<String> {
    let pat = format!("\"{key}\":\"");
    let start = line.find(&pat)? + pat.len();
    let rest = &line[start..];
    let mut out = String::new();
    let mut chars = rest.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => return Some(out),
            '\\' => {
                /* Windows paths arrive as `C:\\atelier\\skein`. Nothing else
                   escaped appears in the fields read here. */
                let next = chars.next()?;
                out.push(if next == 'n' { '\n' } else { next });
            }
            _ => out.push(c),
        }
    }
    None
}

/// How much of a first prompt is kept, when it is standing in for a name.
///
/// A row is one line on a grid, so anything past about this reads as an
/// ellipsis either way — and the whole point of the fallback is a phrase you
/// recognise, which is at the front. The filter searches the clipped text, so
/// this also bounds what a query can match; a longer clip would find more and
/// say less, and the sessions worth finding are found by their opening words.
const PROMPT_CLIP: usize = 120;

/// Everything between `<tag>` and `</tag>`, taken out — including an unclosed
/// opener, which takes the rest of the text with it.
///
/// For `<system-reminder>`, which the CLI appends *inside* a genuine prompt
/// rather than as a record of its own. Left in, it is what a row would be named
/// after: the reminders run to hundreds of characters and every one of them
/// starts the same way, so every such row would read alike and the filter would
/// match all of them at once.
fn without_tag(text: &str, tag: &str) -> String {
    let (open, close) = (format!("<{tag}>"), format!("</{tag}>"));
    let mut out = String::new();
    let mut rest = text;
    while let Some(at) = rest.find(&open) {
        out.push_str(&rest[..at]);
        match rest[at..].find(&close) {
            Some(end) => rest = &rest[at + end + close.len()..],
            None => return out,
        }
    }
    out.push_str(rest);
    out
}

/// Why a `user` record is not somebody speaking.
///
/// **This is a partition, not a set of predicates**, and `docs/ANALYTICS.md`
/// §3.8 published the counts that only a partition can publish: 19,694 tool
/// results against 7,858 subagent turns against 832 human prompts, summing to
/// the 29,268 user records in five days. Counting each marker independently
/// gave 28,962 against a total of 28,879, which is what overlapping predicates
/// look like when they are read as a breakdown. So every record reaches exactly
/// one arm, in the order `fold` asks them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Why {
    /// Not a `user` record at all (`queue-operation`, `summary`, an assistant
    /// line), decided from the line without a parse.
    NotUser,
    /// Past `MAX_PROMPT_BYTES`, decided before the parse for the same reason:
    /// this is the one unbounded parse in the walk.
    Oversize,
    /// `isMeta`: context Claude Code injected, a system reminder's record.
    Meta,
    /// `isSidechain`: a subagent's own turn.
    Sidechain,
    /// `isCompactSummary`: what a compaction left behind.
    CompactSummary,
    /// A tool result: a `user` record whose content carries no `text` block.
    ToolResult,
    /// One of the eight injected markers, opened with, that is an injected
    /// command (`<command-name>` and its family, the local-command caveat).
    Injected,
    /// `<task-notification>`: a background job reporting in.
    TaskNotification,
    /// `[Request interrupted by user…`: the CLI's own stop note.
    StopNote,
    /// `[skein relay]`: a message from another card, the billboard, the sink, a
    /// subscription or the wall's own ride-along. Everything `relay.rs` and
    /// `subscribe/` write into a card's stdin.
    Relay,
    /// `[skein wake]`: a `wake_me` coming due (`later.rs`).
    Wake,
    /// Rousing's resume prompt, sent to a card whose turn was cut off.
    Resume,
    /// Rousing's jobs prompt, sent to a card whose background work never
    /// reported in.
    Jobs,
    /// A `skein here` notice: the background-job notification, and the queue
    /// nudge an older wall still has on the wire.
    Nudge,
    /// The pick-up a card is sent when a turn the *wall* opened failed before a
    /// model saw it.
    Pickup,
    /// The carry-on a card is sent when its account ran out and another one has
    /// room (`classify.ts::CARRY_ON_TEXT`).
    Carry,
    /// The heal's mark, **appended** to a prompt that is sent again rather than
    /// prefixed to it.
    Resend,
    /// Nothing said once the reminder was taken out.
    NoText,
}

/// What a `user` line is, decided once.
///
/// `docs/ANALYTICS.md` §3.8 owes this split: `prompt_of` used to end by
/// flattening the prompt onto one line for the titling grid, and that is
/// exactly the newlines and fences a prompt's *form* counts. So the decision
/// lives here, returning the text **unflattened**, and `prompt_of` sits on top
/// of it as flatten-and-clip. One marker list, one rejection rule, and a second
/// copy is what this arrangement exists to prevent.
///
/// `Prompt` carries the parsed record beside the text because the caller that
/// ingests prompt facts needs the id, the stamp and the session, and handing
/// them over is what keeps one line to one parse. Nothing may store the record's
/// text: what analytics keeps is the form, and the bytes are phase 5b's, behind
/// the vault.
pub(crate) enum Folded {
    Prompt {
        /// Unflattened, with any `<system-reminder>` taken out.
        text: String,
        /// Image blocks counted, never returned: a picture has no text form.
        images: usize,
        record: serde_json::Value,
    },
    /* The class is carried, published in §3.8's table and asserted by
       `each_user_record_reaches_exactly_one_class`, but nothing in the crate
       acts on it: both callers only want to know that it is *not* a prompt.
       It stays because a fold that answers `None` is the shape that let seven
       overlapping predicates read as a partition, and because the next reader
       of this file wants to see which class a record landed in. */
    #[allow(dead_code)]
    Aside(Why),
}

/// **Never the text.** A derived `Debug` on this type prints a prompt body, and
/// one `log::debug!("{folded:?}")` by anybody debugging this filter would put
/// that body in `volery.log`, which is the one place §3.8 says a prompt may
/// never be. So the shape is printed and the words are not, which is also all a
/// reader of a log line needs.
impl std::fmt::Debug for Folded {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Folded::Prompt { text, images, .. } => f
                .debug_struct("Prompt")
                .field("chars", &text.chars().count())
                .field("images", images)
                .finish(),
            Folded::Aside(why) => f.debug_tuple("Aside").field(why).finish(),
        }
    }
}

/// Text Claude Code injected that is not anybody speaking.
///
/// Each of these is a record shaped exactly like a prompt — a `user` type
/// carrying a string — and each would otherwise be what a conversation is named
/// after.
///
/// **The test is anchored, and getting that wrong threw away this change's own
/// commissioning brief.** An injected record *opens* with its marker; a prompt
/// that merely mentions one is a prompt. Written as a bare `contains`, the
/// 5,141-character brief that asked for this panel to be fixed was rejected
/// because it says `<local-command-caveat>` at offset 3,688 — 3,568 characters
/// past the end of the clip it would have produced — and the row was then named
/// after the *next* message in the conversation instead. Two of the 502
/// transcripts here were wrong that way, and the base rate is not the point:
/// prompts about Claude Code's transcript format are exactly what gets typed in
/// this repository.
///
/// `history.ts` and `classify.ts` know most of this family too, by the same
/// words and for the same reason — on disk the `isMeta` flag that would settle
/// it is not always there, and live there is no such flag at all. The overlap
/// is not total and should not be claimed as such: `skillBody` is injected and
/// is the one injected thing worth *reading*, so it has no place here, and the
/// stop note below is the member `history.ts` handles in its non-meta arm.
/// Anything added to that family is worth considering here.
const INJECTED: [(&str, Why); 8] = [
    ("<local-command-caveat>", Why::Injected),
    ("<command-name>", Why::Injected),
    ("<command-message>", Why::Injected),
    ("<command-args>", Why::Injected),
    ("<local-command-stdout>", Why::Injected),
    ("<task-notification>", Why::TaskNotification),
    (
        "Caveat: The messages below were generated by the user while running local commands",
        Why::Injected,
    ),
    /* `isStopNote`'s wording. It demonstrably reaches disk without `isMeta`,
       which is why it is here rather than left to the flag. */
    ("[Request interrupted by user", Why::StopNote),
];

/// Text the **wall** composed and wrote into a card's stdin.
///
/// These are `user` records on disk, exactly like something typed, and counted
/// as prompts they would make the mix and the nudge rate a measurement of
/// Volery talking to itself. So they are rejected and dropped: the prompt
/// record is the person's, and a count of wall chatter is a feature nobody
/// asked for.
///
/// **The strings are copies, and `test/prompt.test.ts` holds each one to the
/// composer it came from** (`classify.ts`, `rousing.ts`, `relay.ts`), because a
/// copy that drifts is either a wall prompt read as a person's or a person's
/// read as the wall's, and the second loses a prompt that cannot be recovered.
/// Each is anchored at the opening, which is where a composed record starts; a
/// person *quoting* one is kept, for the reason `INJECTED`'s anchored test
/// exists.
const WALL: [(&str, Why); 8] = [
    ("[skein relay]", Why::Relay),
    ("[skein wake]", Why::Wake),
    (
        "you were part-way through a turn when skein closed",
        Why::Resume,
    ),
    (
        "background work you started was still running when skein last closed",
        Why::Jobs,
    ),
    (
        "skein here — a background job you started has reported in",
        Why::Nudge,
    ),
    (
        "skein here — if a message is queued behind this one, answer that instead",
        Why::Nudge,
    ),
    (
        "skein: the turn before this one never reached a model",
        Why::Pickup,
    ),
    (
        "skein: your last turn was cut off because the account's allowance ran out",
        Why::Carry,
    ),
];

/// The longest `user` record worth parsing. A tool result is a `user` record
/// too, and the big ones are megabytes; nothing worth naming a conversation
/// after is this long, and this is the one unbounded parse in the walk.
pub(crate) const MAX_PROMPT_BYTES: usize = 256 * 1024;

/// The heal's mark, which is **appended** and so cannot be an opening test.
///
/// `withResendMark` (classify.ts) writes `"\n\n"` and then
/// `skein: attempt N of M at this prompt.` and a sentence, onto a prompt that is
/// being sent again. The whole string is one `user` record, so a retry would
/// otherwise count as a second thing the person said.
///
/// **Found by its shape anywhere, and that is safe enough to accept.** The
/// alternative is to let every healed turn pollute the counts, and it is the
/// rarer case that a person writes two newlines, `skein: attempt `, two numbers
/// around ` of ` and ` at this prompt.` by hand. The `\n\n` is the same anchor
/// `RESEND_MARK_RE` uses on the other side, so the two folds agree about what a
/// mark is.
fn resend_marked(text: &str) -> bool {
    let Some(at) = text.rfind("\n\nskein: attempt ") else {
        return false;
    };
    let rest = &text[at + "\n\n".len()..];
    let Some(rest) = rest.strip_prefix("skein: attempt ") else {
        return false;
    };
    let Some((n, rest)) = rest.split_once(" of ") else {
        return false;
    };
    let Some((m, _)) = rest.split_once(" at this prompt.") else {
        return false;
    };
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit());
    digits(n) && digits(m)
}

/// What this line is: somebody speaking, or the class of thing it is instead.
///
/// Only ever asked of a line until one answers in the titling walk, so the JSON
/// parse happens a handful of times per transcript at most, and the ingest
/// asks it of every `user` line in a file, which is why the two gates below
/// come before the parse. `field` cannot serve here: a prompt is a *value*
/// rather than a token, it arrives in two shapes (a bare string from the TUI, a
/// block array from the SDK), and it is the one field where the escaping
/// matters.
///
/// **The order of the arms is the partition**, and it is the order
/// `docs/ANALYTICS.md` §3.8 measured: the length gate, then the three flags,
/// then the content. Oversize is decided before the parse so such a record is
/// `Oversize` before it can be anything else; the flags come next, so a tool
/// result inside a subagent is a subagent turn and not counted twice.
pub(crate) fn fold(line: &str) -> Folded {
    /* The one cheap gate, and it only ever *skips*: `queue-operation`,
       `summary`, `file-history-snapshot` and every assistant record fail it
       outright, which is nearly all of the head. `\b`-style anchoring on the
       raw text is safe here for a reason the flags do not share: a JSON
       *string* escapes its own quotes, so prose that mentions `"type":"user"`
       arrives as `\"type\":\"user\"` and cannot match this. */
    if !line.contains("\"type\":\"user\"") {
        return Folded::Aside(Why::NotUser);
    }
    if line.len() > MAX_PROMPT_BYTES {
        return Folded::Aside(Why::Oversize);
    }
    /* The same argument for the content shape, and it is worth more than the
       lines it costs: tool results are 184 MB of this machine's five days of
       user records against 66 MB of everything else, and every one of them
       would otherwise be parsed to learn what the line already says. */
    if !carries_text(line) {
        return Folded::Aside(Why::ToolResult);
    }

    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
        return Folded::Aside(Why::NotUser);
    };
    if v.get("type").and_then(|t| t.as_str()) != Some("user") {
        return Folded::Aside(Why::NotUser);
    }
    /* Context Claude Code injected, a subagent's own turn, and the summary a
       compaction leaves: none of them anybody speaking. Read off the parsed
       record rather than the line, because the flag nested inside another
       object on the record reads identically to the field (finding two). */
    for (flag, why) in [
        ("isMeta", Why::Meta),
        ("isSidechain", Why::Sidechain),
        ("isCompactSummary", Why::CompactSummary),
    ] {
        if v.get(flag).and_then(|b| b.as_bool()) == Some(true) {
            return Folded::Aside(why);
        }
    }
    let Some(content) = v.get("message").and_then(|m| m.get("content")) else {
        return Folded::Aside(Why::NoText);
    };
    let mut images = 0usize;
    let said = match content {
        serde_json::Value::String(s) => s.clone(),
        /* The SDK's shape — and the one that is usually a tool result, which
           carries no `text` block and so falls out here as empty. Image blocks
           are counted and never returned: a picture has no text form. */
        serde_json::Value::Array(blocks) => {
            images = blocks
                .iter()
                .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("image"))
                .count();
            blocks
                .iter()
                .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("\n")
        }
        _ => return Folded::Aside(Why::NoText),
    };

    let said = without_tag(&said, "system-reminder");
    /* Anchored — see `INJECTED`. `trim_start` because a reminder taken out of
       the front of a record leaves the whitespace that was around it. */
    let opening = said.trim_start();
    if let Some((_, why)) = INJECTED.iter().find(|(m, _)| opening.starts_with(m)) {
        return Folded::Aside(*why);
    }
    /* The wall's own words, rejected the same way and for a different reason:
       they are not one of the eight markers, they are sentences this app wrote
       to a card. See `WALL`. */
    if let Some((_, why)) = WALL.iter().find(|(m, _)| opening.starts_with(m)) {
        return Folded::Aside(*why);
    }
    /* The heal's mark is at the other end, so it cannot be an opening test. */
    if resend_marked(&said) {
        return Folded::Aside(Why::Resend);
    }
    if said.trim().is_empty() {
        return Folded::Aside(Why::NoText);
    }
    Folded::Prompt {
        text: said,
        images,
        record: v,
    }
}

/// Could this line carry somebody's words at all?
///
/// False only for the one shape it can be certain about: a message whose
/// `content` is an array with no `text` block, which is every tool result in the
/// file. Everything else is parsed, because the parse is what decides it.
///
/// **The message's own delimiter, and not a search of the whole line.** A tool
/// result nests `"content":"a result"` inside its own block, so asking whether
/// the line merely contains a string content answers yes for all 184 MB this
/// exists to skip. So the scan starts at `"message":` and takes the *first*
/// `"content":` after it, which is the message's.
///
/// **And a flag sends the record back to the parse, which is the half that keeps
/// the partition in §3.8's order.** The flags are decided before the content, so
/// a tool result inside a subagent is a subagent turn; skipping it here would
/// count it as a tool result and quietly disagree with the published table. A
/// flag found in the raw text therefore only ever *prevents* a skip, never
/// decides a class, because a `"isMeta":true` nested inside a tool's payload is
/// not a flag on the record. Measured over five days here: the shape alone skips
/// 21,548 records and 226 MB, and honouring the flags first leaves 11,847
/// records and 186 MB skipped, with 64 MB parsed instead of 250 and **no
/// record carrying a `text` block among those skipped**.
///
/// Both tests are structural rather than textual: a JSON string escapes its own
/// quotes, so prose that mentions `"type":"text"` arrives as `\"type\":\"text\"`
/// and cannot match. The spaced spelling is asked about although the CLI writes
/// the tight one (measured over 80 files: 7,800 text blocks, 12,350 string
/// contents, none spaced), because the gate's *correctness* would otherwise rest
/// on a writer's formatting, and getting it wrong here would drop a prompt
/// silently.
fn carries_text(line: &str) -> bool {
    const CONTENT: &str = "\"content\":";
    const FLAGS: [&str; 6] = [
        "\"isMeta\":true",
        "\"isMeta\": true",
        "\"isSidechain\":true",
        "\"isSidechain\": true",
        "\"isCompactSummary\":true",
        "\"isCompactSummary\": true",
    ];
    let Some(message) = line.find("\"message\":") else {
        /* No message object: `fold` will answer `NoText` from the parse. */
        return true;
    };
    let rest = &line[message..];
    let Some(at) = rest.find(CONTENT) else {
        return true;
    };
    let after = rest[at + CONTENT.len()..].trim_start();
    if !after.starts_with('[') || FLAGS.iter().any(|f| line.contains(f)) {
        return true;
    }
    line.contains("\"type\":\"text\"") || line.contains("\"type\": \"text\"")
}

/// The first thing said on this line, if the line is somebody saying something.
///
/// Flatten-and-clip for the titling grid, which is the whole of what it does
/// now that the decision and the parse are `fold`'s. One line, whatever it was
/// written as: a row is a single line on a grid and a prompt with a fenced block
/// in it would otherwise arrive with its newlines intact and be clipped inside
/// the first of them. The *form* is what needs those newlines, and it reads
/// `fold` rather than this.
fn prompt_of(line: &str) -> Option<String> {
    let Folded::Prompt { text, .. } = fold(line) else {
        return None;
    };
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.is_empty() {
        return None;
    }
    Some(clip(&flat, PROMPT_CLIP))
}

/// `text`, cut to at most `max` characters, on a word boundary where there is
/// one near enough to the end to be worth preferring.
fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let head: String = text.chars().take(max).collect();
    /* Only a break in the last quarter counts. Further back than that and the
       word boundary costs more of the phrase than the ragged edge did. */
    let cut = head
        .rfind(' ')
        .filter(|at| *at >= head.len() * 3 / 4)
        .unwrap_or(head.len());
    format!("{}…", head[..cut].trim_end())
}

/// Every transcript Claude Code has written, newest activity first.
///
/// Deliberately says nothing about which of these Skein already knows: the
/// front end holds the wall and can answer that without a query. And it counts
/// no messages — deciding what is a prompt rather than injected context or a
/// subagent's turn is `history.ts`'s job, and duplicating those rules here
/// would give the two readers a chance to disagree.
///
/// Off the main thread, via `crate::off_main`: this walks every directory under
/// `~/.claude/projects` and opens the head and tail of every transcript in them,
/// which is unbounded in the only way that matters — it grows with how long the
/// CLI has been used on this machine.
#[tauri::command]
pub async fn list_sessions(app: AppHandle) -> Result<Vec<Session>, String> {
    crate::off_main(move || {
        let mut out = sessions_of(&app)?;
        let wall = wall_facts(&app);
        /* A conversation this wall gave to another one is running over there,
           and a second card on it here would fork it the moment either was
           spoken to (`flyway-core/src/moving.rs`). The file stays on disk — a move
           never deletes — and is simply not offered. */
        out.retain(|s| !wall.gone.contains(&s.id));
        settle_titles(&mut out, &wall.titles);
        Ok(out)
    })
    .await?
}

/// What this walk asks the database.
struct Wall {
    /// What the wall calls each session it knows, keyed by session id.
    titles: HashMap<String, String>,
    /// Sessions of cards this wall no longer holds because of a move.
    gone: std::collections::HashSet<String>,
}

/// What the wall itself knows about these sessions: what it calls the ones it
/// has met.
///
/// Read inside `off_main` with everything else, so the store lock is never
/// taken on the main thread. An empty answer — no store yet, a wedged mutex —
/// leaves every session titled only by its own transcript.
fn wall_facts(app: &AppHandle) -> Wall {
    let empty = Wall { titles: HashMap::new(), gone: Default::default() };
    let Some(store) = app.try_state::<crate::store::Store>() else {
        return empty;
    };
    let Ok(conn) = store.0.lock() else {
        return empty;
    };
    Wall {
        titles: crate::store::session_titles(&conn).unwrap_or_default(),
        gone: crate::flyway::here::moved_away_sessions(&conn).into_iter().collect(),
    }
}

/// Put a name on every row that has not got one of its own.
///
/// Three sources, in this order, and the order is the whole of the design:
///
/// - **The transcript's `ai-title`**, already read by `read_session`. It is the
///   best of the three and it is usually not there: 187 of the 503 transcripts
///   on this machine have one anywhere in the file, and the head+tail window
///   misses it in exactly one of those 187. So the gap is not a reading
///   problem and no wider read closes it — Claude Code does not write an
///   ai-title for most sessions.
/// - **The wall's own name for the session.** Nearly free, and the sharp one:
///   a card Volery opened has a title in the `conversation` table keyed on the
///   same id this panel is listing. A card closed by accident was therefore
///   offered back as `untitled`, with its real name one table over — which is
///   how somebody loses a conversation they can see the file for.
/// - **The first thing said in it**, which is the only source that covers a
///   session this wall has never met: one a terminal started, or one from
///   before Volery was on this machine.
///
/// A row that ends with none of the three keeps `None` and the panel says
/// `untitled`, which by then is the truth rather than a failure to look.
fn settle_titles(sessions: &mut [Session], titles: &HashMap<String, String>) {
    for s in sessions.iter_mut() {
        if s.title.is_some() {
            continue;
        }
        s.title = titles.get(&s.id).cloned().or_else(|| s.prompt.clone());
    }
}

/// How much of a transcript's beginning is read, for the fields written once at
/// the top: `cwd`, `gitBranch` and the timestamp a session was born at.
///
/// Measured 2026-08-20 over the 278 transcripts on this machine: the first
/// `"cwd"` sat 4.5 KB in at worst (p50 796 bytes) and the first `"timestamp"`
/// 622 bytes (p50 48). Note it is *not* on line one in a single one of them —
/// the first record is a summary or a file-history snapshot — so this is a
/// budget of lines rather than one line, generous enough that the difference
/// costs nothing.
const HEAD: u64 = 64 * 1024;

/// And how much of the end, for the three fields that are last-wins: the
/// closing timestamp, the generated title, and the last answered `assistant`
/// message that carries the model and the occupancy.
///
/// Same measurement: the last `ai-title` record sat 64.8 KB from EOF at worst
/// (p50 8.7 KB) and the last answered `assistant` message 82.3 KB (p50 2.4 KB).
/// 256 KB found every one of the 278 with room to spare — and `whole` below
/// covers the file where it would not, by reading the rest rather than
/// reporting a conversation with no name and no occupancy.
const TAIL: u64 = 256 * 1024;

/// The fields a picker shows, folded out of whatever lines it is fed.
///
/// Fed a file's head and then its tail — in that order — this answers exactly
/// what feeding it every line would, for all but one of the fields it holds.
/// Three are first-wins and no later line can beat them; three are last-wins
/// and a later line only ever improves them. That equivalence is the whole
/// reason the walk is allowed to skip the middle, and it is why overlapping
/// reads on a small file are harmless: feeding the same line twice, in order,
/// changes nothing.
///
/// **`prompt` is the one field the tail may not write**, and that restriction
/// is what keeps the sentence above true of it. The other six are first-wins
/// over fields written near the top by construction, or last-wins over fields a
/// later line can only improve. This one is neither: it is written wherever the
/// first thing anybody said happens to be, so a tail read reaching it would
/// supply a message from the *end* of the conversation as "the first thing
/// said" — a name that is wrong rather than missing, which is the worse of the
/// two failures. `feed` therefore takes it only from a read that began at byte
/// 0. Where the head has none, the field is absent and `settle_titles` falls to
/// its next rung, which is `untitled` and is honest.
///
/// It does not bite on this machine in any case. Measured 2026-09-14 over all
/// 502 transcripts: the first record `prompt_of` accepts sat 278 bytes in at the
/// median, 3.9 KB at p99 and **25.3 KB at worst** — not one of them past `HEAD`,
/// for the same reason the first `cwd` is never far in, which is that the
/// preamble before it is a summary or a file-history snapshot and neither is
/// large.
#[derive(Default)]
struct Scan {
    cwd: Option<String>,
    branch: Option<String>,
    born_at: Option<String>,
    last_at: Option<String>,
    title_line: Option<String>,
    assistant_line: Option<String>,
    /// First-wins, like `cwd` and `born_at` above — the *first* thing said is
    /// the one that says what a conversation was about. It is in the head
    /// window by construction, so it costs no read that was not happening.
    prompt: Option<String>,
}

impl Scan {
    /// `from_head` is whether this line came from a read that started at byte 0
    /// — the head window, or a whole small file, or the `whole` re-read. It
    /// gates exactly one field; see the note on `prompt` below.
    fn feed(&mut self, line: &str, from_head: bool) {
        if line.trim().is_empty() {
            return;
        }
        if self.cwd.is_none() {
            self.cwd = field(line, "cwd");
        }
        if self.branch.is_none() {
            self.branch = field(line, "gitBranch").filter(|b| !b.is_empty());
        }
        if let Some(ts) = field(line, "timestamp") {
            self.born_at.get_or_insert_with(|| ts.clone());
            self.last_at = Some(ts);
        }
        if line.contains("\"ai-title\"") {
            self.title_line = Some(line.to_string());
        }
        /* Head only, and that is what keeps this fold honest. A record 256 KB
           from the end of a file is not "the first thing said" under any
           reading, and naming a row after one would be worse than saying
           nothing: it would be a name that is wrong rather than missing. So the
           tail cannot supply this, and where the head has none the row falls
           through to `settle_titles`' next rung. */
        if from_head && self.prompt.is_none() {
            self.prompt = prompt_of(line);
        }
        /* The usage test is what makes this the last *answered* message: a
           refusal or an interrupted stream carries none. */
        if line.contains("\"type\":\"assistant\"") && line.contains("\"usage\"") {
            self.assistant_line = Some(line.to_string());
        }
    }

    /// Is there nothing left to gain by reading more of this file?
    ///
    /// The two the walk cannot do without: no `cwd` means nothing addressable,
    /// and no answered `assistant` record means either a session that never got
    /// an answer — in which case there is nothing to resume — or a tail that was
    /// cut above the last one. Those two are indistinguishable from here, so the
    /// caller reads the whole file and lets the distinction make itself.
    fn whole(&self) -> bool {
        self.cwd.is_some() && self.assistant_line.is_some()
    }
}

/// Feed `scan` the lines in `[from, from + len)`, dropping a partial one at
/// either edge.
///
/// The dropping is not tidiness. A line cut in half mid-`cwd` hands `field` an
/// unterminated value, which it answers `None` to — that much is safe — but one
/// cut inside a tool result can still carry `"type":"assistant"` and `"usage"`,
/// and then fails to parse as JSON, and the session is reported with no model
/// and an occupancy of zero. So a read that does not start at byte 0 discards
/// its first line, and one that does not reach EOF discards its last.
fn feed_range(scan: &mut Scan, file: &mut File, from: u64, len: u64, size: u64) {
    if file.seek(SeekFrom::Start(from)).is_err() {
        return;
    }
    let lines: Vec<String> = BufReader::new(file.take(len))
        .lines()
        .map_while(Result::ok)
        .collect();
    let mut slice: &[String] = &lines;
    if from > 0 && !slice.is_empty() {
        slice = &slice[1..];
    }
    if from + len < size && !slice.is_empty() {
        slice = &slice[..slice.len() - 1];
    }
    for line in slice {
        scan.feed(line, from == 0);
    }
}

/// Everything one transcript says about itself, or nothing if it says too
/// little to be adopted.
fn read_session(path: &Path, id: String) -> Option<Session> {
    let bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let mut file = File::open(path).ok()?;

    let mut scan = Scan::default();
    if bytes <= HEAD + TAIL {
        /* Small enough that the two reads would overlap most of it anyway — and
           most of them are: the median transcript here is 28 KB. One read, no
           seeking, and either `whole` is satisfied or the file genuinely lacks
           what it wants. */
        feed_range(&mut scan, &mut file, 0, bytes, bytes);
    } else {
        feed_range(&mut scan, &mut file, 0, HEAD, bytes);
        feed_range(&mut scan, &mut file, bytes - TAIL, TAIL, bytes);
        /* The measurement above says this does not happen on this machine. It is
           here because that is a measurement of one machine on one day, and the
           cost of being wrong without it is a row reading "untitled · 0%" for a
           conversation that has a name — worse than the cost of being wrong with
           it, which is one file read twice. */
        if !scan.whole() {
            scan = Scan::default();
            feed_range(&mut scan, &mut file, 0, bytes, bytes);
        }
    }

    /* No cwd means nothing addressable; no assistant record means the session
       never got an answer and there is nothing to resume. Three of the 278
       transcripts here are one or the other. */
    let (Some(cwd), Some(assistant)) = (scan.cwd.clone(), scan.assistant_line.as_ref()) else {
        return None;
    };

    let title = scan
        .title_line
        .as_deref()
        .and_then(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .and_then(|v| {
            v.get("aiTitle")
                .and_then(|t| t.as_str())
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .map(String::from)
        });

    let mut model = None;
    let mut ctx_tokens = 0u64;
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(assistant) {
        let msg = v.get("message");
        /* The bare API name, with no window tier — `[1m]` reaches the wire only
           on `system/init`, which is not written to the transcript. An imported
           card therefore cannot know its window until it wakes; `#adoptModel`
           settles it then. */
        model = msg
            .and_then(|m| m.get("model"))
            .and_then(|m| m.as_str())
            .map(String::from);
        if let Some(u) = msg.and_then(|m| m.get("usage")) {
            let n = |k: &str| u.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
            /* Matches the live fold exactly — and note it is this message's
               usage, never a sum across the turn. */
            ctx_tokens = n("input_tokens")
                + n("cache_read_input_tokens")
                + n("cache_creation_input_tokens")
                + n("output_tokens");
        }
    }

    Some(Session {
        id,
        cwd,
        branch: scan.branch,
        title,
        prompt: scan.prompt,
        model,
        ctx_tokens,
        born_at: scan.born_at,
        last_at: scan.last_at,
        bytes,
    })
}

/// The walk itself, apart from the command that carries it.
fn sessions_of(app: &AppHandle) -> Result<Vec<Session>, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("no home dir: {e}"))?;
    walk(&home.join(".claude").join("projects"))
}

/// Every transcript under `root`, newest activity first.
///
/// Split from `sessions_of` so it can be pointed at a fixture directory: what is
/// worth testing here is the reading, and the reading has nothing to do with
/// where the CLI happens to keep its files.
fn walk(root: &Path) -> Result<Vec<Session>, String> {
    let Ok(dirs) = std::fs::read_dir(root) else {
        // No CLI sessions on this machine at all is an empty list, not a fault.
        return Ok(Vec::new());
    };

    let mut out: Vec<Session> = Vec::new();
    for dir in dirs.flatten() {
        if !dir.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let Ok(files) = std::fs::read_dir(dir.path()) else {
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(id) = path.file_stem().and_then(|s| s.to_str()).map(String::from) else {
                continue;
            };
            if let Some(session) = read_session(&path, id) {
                out.push(session);
            }
        }
    }

    /* Newest first, and the picker leans on it harder than it looks: that list
       is what you see before you have typed anything, so its order is the whole
       of the answer to "what was I just doing". A missing timestamp sorts last,
       which is where a transcript that never said when it was belongs. */
    out.sort_by(|a, b| b.last_at.cmp(&a.last_at));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::{
        clip, field, fold, prompt_of, settle_titles, walk, Folded, Session, Why,
        MAX_PROMPT_BYTES,
    };
    use std::collections::HashMap;

    /// A session that says only where it was, which is all `settle_titles`
    /// needs of one besides its id.
    fn at(cwd: &str) -> Session {
        Session {
            id: "s".into(),
            cwd: cwd.into(),
            branch: None,
            title: None,
            prompt: None,
            model: None,
            ctx_tokens: 0,
            born_at: None,
            last_at: None,
            bytes: 0,
        }
    }

    #[test]
    fn a_field_is_read_without_parsing_the_line() {
        let line = r#"{"type":"user","timestamp":"2026-08-11T05:38:38.213Z","cwd":"C:\\atelier\\caravan"}"#;
        assert_eq!(
            field(line, "timestamp"),
            Some("2026-08-11T05:38:38.213Z".into())
        );
        // The escaped separators have to survive, or nothing matches a project.
        assert_eq!(field(line, "cwd"), Some("C:\\atelier\\caravan".into()));
    }

    #[test]
    fn an_absent_field_is_absent_rather_than_wrong() {
        let line = r#"{"type":"queue-operation","operation":"enqueue"}"#;
        assert_eq!(field(line, "cwd"), None);
        assert_eq!(field(line, "timestamp"), None);
    }

    /// Tool output is full of text that looks like a field. Reading stops at the
    /// closing quote of the value, so a later mention cannot overwrite it.
    #[test]
    fn the_first_match_wins_and_stops_at_its_own_quote() {
        let line = r#"{"cwd":"C:\\atelier","content":"the \"cwd\":\"C:\\elsewhere\" was printed"}"#;
        assert_eq!(field(line, "cwd"), Some("C:\\atelier".into()));
    }

    /// A transcript with the fields at the top and the bottom and a megabyte of
    /// tool output in between — which is every real one, in miniature. What is
    /// asserted is that the reading is *unchanged* by the middle being skipped:
    /// the same cwd, the same title, the same occupancy as a full read gives.
    #[test]
    fn the_middle_of_a_large_transcript_is_not_read_and_costs_nothing() {
        let dir = std::env::temp_dir().join(format!("skein-sessions-{}", crate::store::uuid_v4()));
        let proj = dir.join("C--atelier-skein");
        std::fs::create_dir_all(&proj).unwrap();

        let id = "11111111-2222-3333-4444-555555555555";
        let mut body = String::new();
        // The head: a summary first, as the CLI writes it — cwd is never on line one.
        body.push_str("{\"type\":\"summary\",\"summary\":\"an older thread\"}\n");
        body.push_str(
            "{\"cwd\":\"C:\\\\atelier\\\\skein\",\"gitBranch\":\"main\",\"type\":\"user\",\"timestamp\":\"2026-08-01T10:00:00.000Z\"}\n",
        );
        // The middle: one tool result of a megabyte, and nothing worth reading.
        body.push_str("{\"type\":\"user\",\"message\":{\"content\":\"");
        body.push_str(&"x".repeat(1024 * 1024));
        body.push_str("\"},\"timestamp\":\"2026-08-01T10:30:00.000Z\"}\n");
        // Padding, so head and tail cannot meet.
        for i in 0..400 {
            body.push_str(&format!(
                "{{\"type\":\"user\",\"message\":{{\"content\":\"{}\"}},\"timestamp\":\"2026-08-01T11:{:02}:00.000Z\"}}\n",
                "y".repeat(1024),
                i % 60
            ));
        }
        // The tail: the last answered message, then the generated title.
        body.push_str(
            "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-opus-5\",\"usage\":{\"input_tokens\":10,\"cache_read_input_tokens\":90,\"cache_creation_input_tokens\":0,\"output_tokens\":100}},\"timestamp\":\"2026-08-02T09:00:00.000Z\"}\n",
        );
        body.push_str(
            "{\"type\":\"ai-title\",\"aiTitle\":\"the adoption panel\",\"timestamp\":\"2026-08-02T09:00:01.000Z\"}\n",
        );
        std::fs::write(proj.join(format!("{id}.jsonl")), &body).unwrap();

        let out = walk(&dir).unwrap();
        assert_eq!(out.len(), 1);
        let s = &out[0];
        assert_eq!(s.id, id);
        assert_eq!(s.cwd, "C:\\atelier\\skein");
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert_eq!(s.title.as_deref(), Some("the adoption panel"));
        assert_eq!(s.model.as_deref(), Some("claude-opus-5"));
        assert_eq!(s.ctx_tokens, 200);
        /* Born at the top, last heard from at the bottom — and the bottom is
           the title record, which carries a timestamp of its own. Last-wins
           over every line, exactly as it was when every line was read. */
        assert_eq!(s.born_at.as_deref(), Some("2026-08-01T10:00:00.000Z"));
        assert_eq!(s.last_at.as_deref(), Some("2026-08-02T09:00:01.000Z"));
        assert!(s.bytes > 1024 * 1024);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// The fallback, which is the reason `whole` exists. A transcript whose only
    /// answered message is in the middle is one the tail cannot see — and the
    /// answer is to read the rest, not to report a conversation with no model
    /// and an occupancy of zero.
    #[test]
    fn an_answer_only_in_the_middle_is_still_found() {
        let dir = std::env::temp_dir().join(format!("skein-sessions-{}", crate::store::uuid_v4()));
        let proj = dir.join("C--atelier-skein");
        std::fs::create_dir_all(&proj).unwrap();

        let mut body = String::new();
        body.push_str(
            "{\"cwd\":\"C:\\\\atelier\\\\skein\",\"type\":\"user\",\"timestamp\":\"2026-08-01T10:00:00.000Z\"}\n",
        );
        body.push_str(&format!("{{\"type\":\"user\",\"message\":{{\"content\":\"{}\"}}}}\n", "x".repeat(80 * 1024)));
        body.push_str(
            "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-sonnet-5\",\"usage\":{\"input_tokens\":1,\"cache_read_input_tokens\":0,\"cache_creation_input_tokens\":0,\"output_tokens\":2}},\"timestamp\":\"2026-08-01T10:01:00.000Z\"}\n",
        );
        /* Everything after it is bulk, and more than TAIL of it — so the tail
           read reaches back only into padding. */
        for _ in 0..400 {
            body.push_str(&format!(
                "{{\"type\":\"user\",\"message\":{{\"content\":\"{}\"}}}}\n",
                "y".repeat(1024)
            ));
        }
        body.push_str(&format!("{{\"type\":\"user\",\"message\":{{\"content\":\"{}\"}}}}\n", "z".repeat(600 * 1024)));
        std::fs::write(proj.join("aaaa.jsonl"), &body).unwrap();

        let out = walk(&dir).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].model.as_deref(), Some("claude-sonnet-5"));
        assert_eq!(out[0].ctx_tokens, 3);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// A session with no answer in it at all is not offered, and neither is one
    /// that never said where it was — there is nothing to resume in either.
    #[test]
    fn a_transcript_with_nothing_to_resume_is_left_out() {
        let dir = std::env::temp_dir().join(format!("skein-sessions-{}", crate::store::uuid_v4()));
        let proj = dir.join("C--atelier-skein");
        std::fs::create_dir_all(&proj).unwrap();

        std::fs::write(
            proj.join("no-answer.jsonl"),
            "{\"cwd\":\"C:\\\\atelier\\\\skein\",\"type\":\"user\",\"timestamp\":\"2026-08-01T10:00:00.000Z\"}\n",
        )
        .unwrap();
        std::fs::write(
            proj.join("no-cwd.jsonl"),
            "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-opus-5\",\"usage\":{\"input_tokens\":1}}}\n",
        )
        .unwrap();
        // Not a transcript at all.
        std::fs::write(proj.join("notes.txt"), "nothing here\n").unwrap();

        assert!(walk(&dir).unwrap().is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The fallback ladder, which is the whole of why a closed card was offered
    /// back as `untitled` while its name sat in the `conversation` table.
    ///
    /// Four rows, one for each rung and one for the bottom: a transcript that
    /// named itself keeps its own name and the wall's is not allowed to beat
    /// it; a transcript with no name of its own takes the wall's; one the wall
    /// has never met takes its first prompt; and one with none of the three
    /// stays `None`, which is the panel saying `untitled` truthfully.
    #[test]
    fn a_row_takes_the_best_name_there_is_and_the_order_is_the_point() {
        let mut sessions = vec![at("c"), at("c"), at("c"), at("c")];
        sessions[0].id = "has-own".into();
        sessions[0].title = Some("its own ai-title".into());
        sessions[0].prompt = Some("the first thing said".into());
        sessions[1].id = "on-the-wall".into();
        sessions[1].prompt = Some("the first thing said".into());
        sessions[2].id = "a-stranger".into();
        sessions[2].prompt = Some("the first thing said".into());
        sessions[3].id = "nothing-at-all".into();

        let titles: HashMap<String, String> = [
            ("has-own".to_string(), "what the wall calls it".to_string()),
            (
                "on-the-wall".to_string(),
                "the shader representing flow on the 2d pl…".to_string(),
            ),
        ]
        .into_iter()
        .collect();
        settle_titles(&mut sessions, &titles);

        assert_eq!(sessions[0].title.as_deref(), Some("its own ai-title"));
        assert_eq!(
            sessions[1].title.as_deref(),
            Some("the shader representing flow on the 2d pl…")
        );
        assert_eq!(sessions[2].title.as_deref(), Some("the first thing said"));
        assert_eq!(sessions[3].title, None);
    }

    /// And the reading half of that ladder: a transcript with no `ai-title`
    /// anywhere in it — which is 316 of the 503 on this machine — still comes
    /// back knowing what was said first.
    ///
    /// Both shapes, in one file each: the TUI writes a bare string and the SDK
    /// writes a block array, and a picker that could only read one of them
    /// would be blank for every session the other front end started.
    #[test]
    fn a_transcript_that_never_named_itself_still_says_what_was_asked_of_it() {
        let dir = std::env::temp_dir().join(format!("skein-sessions-{}", crate::store::uuid_v4()));
        let proj = dir.join("C--atelier-skein");
        std::fs::create_dir_all(&proj).unwrap();

        let answered = r#"{"type":"assistant","message":{"model":"claude-opus-5","usage":{"input_tokens":1}},"timestamp":"2026-08-01T10:05:00.000Z"}"#;

        let mut tui = String::new();
        /* Everything before the prompt that looks like one and is not. Each of
           these was a real row's name before `prompt_of` knew them. */
        tui.push_str("{\"type\":\"summary\",\"summary\":\"an older thread\"}\n");
        tui.push_str(concat!(
            r#"{"type":"queue-operation","operation":"enqueue","cwd":"C:\\atelier\\skein"}"#,
            "\n"
        ));
        tui.push_str(concat!(
            r#"{"type":"user","isMeta":true,"message":{"content":"Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these"},"timestamp":"2026-08-01T10:00:00.000Z"}"#,
            "\n"
        ));
        tui.push_str(concat!(
            r#"{"type":"user","message":{"content":"<command-name>/clear</command-name>"},"timestamp":"2026-08-01T10:00:01.000Z"}"#,
            "\n"
        ));
        /* And the wall's own words, which are the one record class that looks
           most like a prompt: a card first spoken to by a relay has to be named
           by the first thing a *person* said, or stay untitled. */
        tui.push_str(concat!(
            r#"{"type":"user","message":{"content":"[skein relay] from \"another card\" (ab12) in volery —\n\nlook at this"},"timestamp":"2026-08-01T10:00:02.000Z"}"#,
            "\n"
        ));
        tui.push_str(concat!(
            r#"{"cwd":"C:\\atelier\\skein","gitBranch":"main","type":"user","message":{"content":"the shader representing flow on the 2d plane\nis drawing the wrong way round<system-reminder>this is not what anybody said</system-reminder>"},"timestamp":"2026-08-01T10:01:00.000Z"}"#,
            "\n"
        ));
        tui.push_str(concat!(
            r#"{"type":"user","message":{"content":"and a second thing, which is not the name"},"timestamp":"2026-08-01T10:02:00.000Z"}"#,
            "\n"
        ));
        tui.push_str(answered);
        tui.push('\n');
        std::fs::write(proj.join("tui.jsonl"), &tui).unwrap();

        let mut sdk = String::new();
        sdk.push_str(concat!(
            r#"{"cwd":"C:\\atelier\\skein","type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"x","content":"a result, which nobody said"}]},"timestamp":"2026-08-01T10:00:00.000Z"}"#,
            "\n"
        ));
        sdk.push_str(concat!(
            r#"{"type":"user","message":{"content":[{"type":"text","text":"what the sdk writes"}]},"timestamp":"2026-08-01T10:01:00.000Z"}"#,
            "\n"
        ));
        sdk.push_str(answered);
        sdk.push('\n');
        std::fs::write(proj.join("sdk.jsonl"), &sdk).unwrap();

        let mut out = walk(&dir).unwrap();
        assert_eq!(out.len(), 2);
        {
            let by = |id: &str| out.iter().find(|s| s.id == id).unwrap();
            assert_eq!(
                by("tui").prompt.as_deref(),
                Some("the shader representing flow on the 2d plane is drawing the wrong way round")
            );
            assert_eq!(by("sdk").prompt.as_deref(), Some("what the sdk writes"));
            /* Neither file has an ai-title, so both are nameless until the
               ladder runs. */
            assert_eq!(by("tui").title, None);
        }

        settle_titles(&mut out, &HashMap::new());
        let by = |id: &str| out.iter().find(|s| s.id == id).unwrap();
        assert_eq!(
            by("tui").title.as_deref(),
            Some("the shader representing flow on the 2d plane is drawing the wrong way round")
        );
        assert_eq!(by("sdk").title.as_deref(), Some("what the sdk writes"));

        std::fs::remove_dir_all(&dir).ok();
    }

    /// The records that are shaped exactly like a prompt and are not one. Each
    /// is a row that would otherwise be named after machinery — and the
    /// `<command-name>` one is the case where every `/clear` on the wall would
    /// have produced a row called "clear".
    #[test]
    fn injected_context_is_not_something_anybody_said() {
        let said = |c: &str| format!(r#"{{"type":"user","message":{{"content":"{c}"}}}}"#);
        assert_eq!(
            prompt_of(&said("a real question")).as_deref(),
            Some("a real question")
        );

        assert_eq!(prompt_of(&said("<command-name>/clear</command-name>")), None);
        assert_eq!(
            prompt_of(&said("<local-command-caveat>not yours</local-command-caveat>")),
            None
        );
        assert_eq!(
            prompt_of(&said("<local-command-stdout>output</local-command-stdout>")),
            None
        );
        assert_eq!(
            prompt_of(&said("<task-notification>a job finished</task-notification>")),
            None
        );
        assert_eq!(
            prompt_of(r#"{"type":"queue-operation","operation":"enqueue"}"#),
            None
        );
        assert_eq!(
            prompt_of(
                r#"{"type":"user","isMeta":true,"message":{"content":"Continue from where you left off."}}"#
            ),
            None
        );
        assert_eq!(
            prompt_of(
                r#"{"type":"user","isSidechain":true,"message":{"content":"a subagent's brief"}}"#
            ),
            None
        );
        assert_eq!(
            prompt_of(
                r#"{"type":"user","isCompactSummary":true,"message":{"content":"what this card used to know"}}"#
            ),
            None
        );
        /* A prompt that is nothing but an injected reminder is not a prompt —
           and one with a reminder stuck to the end of it keeps its own words. */
        assert_eq!(
            prompt_of(&said("<system-reminder>only this</system-reminder>")),
            None
        );
        assert_eq!(
            prompt_of(&said(
                "what I typed<system-reminder>and what I did not</system-reminder>"
            ))
            .as_deref(),
            Some("what I typed")
        );
        /* Anchored, not `contains`. Each of these mentions a marker well past
           the end of the clip it produces, and each is somebody talking. The
           first is the shape of the brief that commissioned this change, which
           a bare `contains` threw away. */
        assert_eq!(
            prompt_of(&said("fix the adopt panel. be careful to skip <local-command-caveat> records"))
                .as_deref(),
            Some("fix the adopt panel. be careful to skip <local-command-caveat> records")
        );
        assert_eq!(
            prompt_of(&said("why does the transcript say <command-name> on those lines?")).as_deref(),
            Some("why does the transcript say <command-name> on those lines?")
        );
        /* And the flags, for the same reason one level down. They are fields on
           the record, so they are read off the parsed value: a raw scan of the
           line finds one nested inside some *other* object and rejects a prompt
           for a flag that is not on it. */
        assert_eq!(
            prompt_of(
                r#"{"type":"user","toolUseResult":{"isMeta":true},"message":{"content":"a real question"}}"#
            )
            .as_deref(),
            Some("a real question")
        );
        /* The stop note, which reaches disk with no flag on it at all. */
        assert_eq!(prompt_of(&said("[Request interrupted by user]")), None);
        assert_eq!(prompt_of(&said("[Request interrupted by user for tool use]")), None);

        /* A tool result carries no text block, so it reads as nothing said —
           which is what keeps a picker from naming a session after the first
           thing a tool printed into it. */
        assert_eq!(
            prompt_of(
                r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"a result"}]}}"#
            ),
            None
        );
    }

    /// Every class `docs/ANALYTICS.md` §3.8 publishes, one record each, and the
    /// classes are a **partition**: each record reaches exactly one arm, so a
    /// count over a window sums to the total. The order is `fold`'s and it is
    /// the order the measurement used.
    #[test]
    fn each_user_record_reaches_exactly_one_class() {
        let said = |c: &str| format!(r#"{{"type":"user","message":{{"content":"{c}"}}}}"#);
        let class = |line: &str| match fold(line) {
            Folded::Prompt { .. } => None,
            Folded::Aside(why) => Some(why),
        };

        assert_eq!(class("{\"type\":\"summary\",\"summary\":\"x\"}"), Some(Why::NotUser));
        assert_eq!(class("{\"type\":\"assistant\",\"message\":{}}"), Some(Why::NotUser));
        /* Oversize, decided before the parse: a user record past the cap does
           not even get read, which is the only bound on this walk's parse. */
        let huge = format!(
            r#"{{"type":"user","message":{{"content":"{}"}}}}"#,
            "x".repeat(MAX_PROMPT_BYTES)
        );
        assert_eq!(class(&huge), Some(Why::Oversize));
        assert_eq!(
            class(r#"{"type":"user","isMeta":true,"message":{"content":"a reminder"},"timestamp":"2026-08-01T10:00:00.000Z"}"#),
            Some(Why::Meta)
        );
        assert_eq!(
            class(r#"{"type":"user","isSidechain":true,"message":{"content":"a subagent's brief"}}"#),
            Some(Why::Sidechain)
        );
        assert_eq!(
            class(r#"{"type":"user","isCompactSummary":true,"message":{"content":"what it knew"}}"#),
            Some(Why::CompactSummary)
        );
        /* A tool result, and the *structural* gate is what decides it: no
           string content and no text block in the line, so no parse at all. */
        assert_eq!(
            class(r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"a result"}]}}"#),
            Some(Why::ToolResult)
        );
        /* And the order, which the shape gate could quietly invert: a tool
           result *inside a subagent* is a subagent turn, because the flags come
           before the content. */
        assert_eq!(
            class(r#"{"type":"user","isSidechain":true,"message":{"content":[{"type":"tool_result","content":"a result"}]}}"#),
            Some(Why::Sidechain)
        );
        assert_eq!(
            class(&said("<command-name>/clear</command-name>")),
            Some(Why::Injected)
        );
        assert_eq!(
            class(&said("<local-command-caveat>not yours</local-command-caveat>")),
            Some(Why::Injected)
        );
        assert_eq!(
            class(&said("<task-notification>a job finished</task-notification>")),
            Some(Why::TaskNotification)
        );
        assert_eq!(
            class(&said("[Request interrupted by user]")),
            Some(Why::StopNote)
        );
        assert_eq!(
            class(&said("<system-reminder>only this</system-reminder>")),
            Some(Why::NoText)
        );
        assert_eq!(class(&said("   ")), Some(Why::NoText));
        /* And the one that is somebody speaking reaches none of them. */
        assert_eq!(class(&said("a real question")), None);
    }

    /// One record per shape the **wall** writes into a card's stdin, and a
    /// person who merely talks about one.
    ///
    /// The fixtures are the composers' own openings, escaped by the JSON writer
    /// rather than by hand so a quote or a newline in one is a fixture, not a
    /// broken line. The last two are the other direction, and they are the ones
    /// that matter: a prompt *about* the relay format is exactly what gets
    /// typed in this repository, and rejecting it would lose words nobody can
    /// get back.
    #[test]
    fn the_wall_speaking_is_not_somebody_speaking() {
        let record = |text: &str| {
            format!(
                r#"{{"type":"user","message":{{"content":{}}}}}"#,
                serde_json::to_string(text).unwrap()
            )
        };
        let class = |text: &str| match fold(&record(text)) {
            Folded::Prompt { .. } => None,
            Folded::Aside(why) => Some(why),
        };
        let shapes: [(&str, Why); 8] = [
            (
                "[skein relay] from \"a card\" (ab12) in volery —\n\nhere is what I found",
                Why::Relay,
            ),
            (
                "[skein wake] you asked to be woken about this 10 minutes ago, and it is now:",
                Why::Wake,
            ),
            (
                "you were part-way through a turn when skein closed, so that turn was cut\noff mid-flight.",
                Why::Resume,
            ),
            (
                "background work you started was still running when skein last closed, and\nits result was never reported back to you.",
                Why::Jobs,
            ),
            (
                "skein here — a background job you started has reported in.",
                Why::Nudge,
            ),
            (
                "skein here — if a message is queued behind this one, answer that instead.",
                Why::Nudge,
            ),
            (
                "skein: the turn before this one never reached a model — the api was overloaded — so whatever opened it has not been answered",
                Why::Pickup,
            ),
            (
                "skein: your last turn was cut off because the account's allowance ran out — nothing you did.",
                Why::Carry,
            ),
        ];
        for (text, want) in shapes {
            assert_eq!(class(text), Some(want), "the wall's {text:?} was read as a prompt");
        }

        /* The heal's mark, which is appended rather than prefixed. */
        let resent = "fix the header, it is one line too tall\n\nskein: attempt 2 of 3 at this prompt. the one before it failed before reaching a model";
        assert_eq!(class(resent), Some(Why::Resend));
        /* And a prompt that opens normally but carries no mark is a prompt. */
        assert_eq!(class("fix the header\n\nskein: the attempt before it failed"), None);

        /* A person talking about the wall is a person. */
        assert_eq!(class("why does [skein relay] appear in the transcript?"), None);
        assert_eq!(
            class("the relay prefixed its message with [skein relay], is that right?"),
            None
        );
        assert_eq!(class("skein: here is what I mean by that"), None);
    }

    /// The gate on a record's shape must not reject a prompt that merely *says*
    /// the words it looks for: a JSON string escapes its own quotes, so prose
    /// can never imitate a delimiter.
    #[test]
    fn prose_about_the_format_is_still_a_prompt() {
        let line = r#"{"type":"user","message":{"content":"a prompt that mentions toolUseResult and \"type\":\"tool_result\" in passing"}}"#;
        let Folded::Prompt { text, .. } = fold(line) else {
            panic!("a prompt about the transcript format was refused");
        };
        assert!(text.contains("toolUseResult"));
    }

    /// The reason the fold exists: a prompt's *form* counts its lines and its
    /// fences, and `prompt_of`'s flattening is exactly what would destroy them.
    #[test]
    fn a_fenced_prompt_keeps_its_lines_for_the_form_and_loses_them_for_a_title() {
        let line = r#"{"type":"user","message":{"content":"draw a box:\n```rust\nfn main() {}\n```\ndone"}}"#;
        let Folded::Prompt { text, .. } = fold(line) else {
            panic!("a prompt with a fence was refused");
        };
        assert_eq!(text, "draw a box:\n```rust\nfn main() {}\n```\ndone");
        assert_eq!(
            prompt_of(line).as_deref(),
            Some("draw a box: ```rust fn main() {} ``` done")
        );
    }

    /// A picture is counted and never returned, because a form has no place to
    /// put it and the bytes are not this module's to keep.
    #[test]
    fn image_blocks_are_counted_and_their_bytes_are_not() {
        let line = r#"{"type":"user","message":{"content":[{"type":"image","source":{"data":"AAAA"}},{"type":"text","text":"what is this"}]}}"#;
        let Folded::Prompt { text, images, .. } = fold(line) else {
            panic!("a prompt with a picture attached was refused");
        };
        assert_eq!(text, "what is this");
        assert_eq!(images, 1);
    }

    /// The tail may not name a conversation.
    ///
    /// A transcript whose only thing-anybody-said sits past `HEAD`, and whose
    /// head and tail therefore cannot meet, comes back with no prompt at all,
    /// rather than with a sentence from the far end of the conversation
    /// presented as the first thing in it. `settle_titles` then says `untitled`,
    /// which is the truth. See the note on `Scan`.
    #[test]
    fn a_message_from_the_end_of_a_file_is_not_the_first_thing_said() {
        let dir = std::env::temp_dir().join(format!("skein-sessions-{}", crate::store::uuid_v4()));
        let proj = dir.join("C--atelier-skein");
        std::fs::create_dir_all(&proj).unwrap();

        let mut body = String::new();
        /* Addressable, and nothing said: the head carries a cwd and then only
           records `prompt_of` refuses. */
        body.push_str(concat!(
            r#"{"cwd":"C:\\atelier\\skein","type":"user","isMeta":true,"message":{"content":"Continue from where you left off."},"timestamp":"2026-08-01T10:00:00.000Z"}"#,
            "\n"
        ));
        /* Bulk enough that the head window ends here and the tail cannot reach
           back this far. */
        let pad = "y".repeat(1024);
        for _ in 0..700 {
            body.push_str(r#"{"type":"assistant","message":{"content":""#);
            body.push_str(&pad);
            body.push_str(concat!(r#""}}"#, "\n"));
        }
        body.push_str(concat!(
            r#"{"type":"user","message":{"content":"something said a long way in"},"timestamp":"2026-08-01T11:00:00.000Z"}"#,
            "\n"
        ));
        body.push_str(concat!(
            r#"{"type":"assistant","message":{"model":"claude-opus-5","usage":{"input_tokens":1}},"timestamp":"2026-08-01T11:01:00.000Z"}"#,
            "\n"
        ));
        std::fs::write(proj.join("late.jsonl"), &body).unwrap();

        let mut out = walk(&dir).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].prompt, None, "the tail may not supply a first prompt");
        settle_titles(&mut out, &HashMap::new());
        assert_eq!(out[0].title, None, "and the row says untitled, honestly");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// A clip is a phrase you recognise, so it ends on a word where there is one
    /// close enough to the end to be worth the characters — and never throws
    /// away most of the phrase to find one where there is not.
    #[test]
    fn a_name_cut_out_of_a_prompt_ends_somewhere_readable() {
        assert_eq!(clip("short enough", 40), "short enough");
        /* A break in the last quarter of the budget: the word wins. */
        assert_eq!(clip("abcdefghij klm nop", 12), "abcdefghij…");
        /* One further back than that: the budget wins, because finding the
           boundary would cost more of the phrase than the ragged edge does. */
        assert_eq!(clip("one two three four five", 12), "one two thre…");
        assert_eq!(clip("aaaa bbbbbbbbbbbbbbbbbbbbbbbb", 16), "aaaa bbbbbbbbbbb…");
        /* Counted in characters and cut on a character, so a multi-byte one on
           the boundary is neither split nor a panic. */
        assert_eq!(clip("ééééé", 3), "ééé…");
    }

    /// Newest activity first, because that order *is* the panel's answer to
    /// "what was I just doing" — it is what you see before you have typed a
    /// thing, and a list nobody has sorted is a list nobody can read.
    #[test]
    fn the_catalogue_is_newest_first() {
        let dir = std::env::temp_dir().join(format!("skein-sessions-{}", crate::store::uuid_v4()));
        let proj = dir.join("C--atelier-skein");
        std::fs::create_dir_all(&proj).unwrap();

        let at = |ts: &str| {
            format!(
                "{{\"cwd\":\"C:\\\\atelier\\\\skein\",\"type\":\"user\",\"timestamp\":\"{ts}\"}}\n{{\"type\":\"assistant\",\"message\":{{\"model\":\"claude-opus-5\",\"usage\":{{\"input_tokens\":1}}}},\"timestamp\":\"{ts}\"}}\n"
            )
        };
        std::fs::write(proj.join("older.jsonl"), at("2026-07-01T10:00:00.000Z")).unwrap();
        std::fs::write(proj.join("newest.jsonl"), at("2026-08-19T10:00:00.000Z")).unwrap();
        std::fs::write(proj.join("middle.jsonl"), at("2026-08-01T10:00:00.000Z")).unwrap();

        let ids: Vec<String> = walk(&dir).unwrap().into_iter().map(|s| s.id).collect();
        assert_eq!(ids, vec!["newest", "middle", "older"]);

        std::fs::remove_dir_all(&dir).ok();
    }
}
