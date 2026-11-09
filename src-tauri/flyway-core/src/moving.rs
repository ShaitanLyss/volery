//! Moving a card to another wall — the pure half.
//!
//! *"I can spawn cards on both laptops and control them from my work laptop"* is
//! one direction of the flyway; this is the other: a card that is already
//! running, with a conversation behind it, picking up where it was on a
//! different machine — the desktop that has the toolchain, the laptop leaving
//! for the office. `tools/probe-migrate.ts` answered the question everything
//! rests on: **a session transplants verbatim**. Put the transcript where the
//! other machine's CLI looks for it, `--resume`, and the model has its history;
//! no record is rewritten.
//!
//! So a move is: quiesce on A → ship the transcript and the rows → resume on B →
//! **confirm the model still has its history** → release A. This file is the
//! vocabulary for that and every decision in it that can be made without a
//! socket, a store or a process; `link.rs` and `store.rs` are the wiring.
//!
//! ### The one sentence the whole design answers to
//!
//! **A card that exists nowhere is the one outcome that must be impossible.**
//! Everything below is arranged so the worst a crash, a lid, a lost frame or a
//! disagreement can leave is a card on *both* walls — two copies, which a person
//! can tell apart and close one of — never on neither:
//!
//! - **A's copy is never deleted.** Releasing it is closing its row and marking
//!   it moved (`flyway_move`), and the transcript stays on A's disk. A releases
//!   only on hearing B say the card *answered with its history* — never on B
//!   saying it received the bytes.
//! - **B only takes its copy away when A has said it kept its own** (`Out::Kept`,
//!   `settle_out`), or when B's own check failed, which A hears as `ok: false`
//!   and answers by keeping. Neither wall acts on its own reading of the other.
//! - **A's decision is one persisted word.** `InFlight` becomes `Released` or
//!   `Kept` exactly once, and every later question about the move is answered
//!   from it — a late confirmation after A gave up gets `Kept`, so B's copy goes
//!   and A's stays.
//! - **Nothing waits for ever.** A gives up after `SETTLE_WITHIN_MS` and keeps
//!   its card; B fails a confirmation not given within `CONFIRM_WITHIN_MS`.
//!   The second is inside the first, so in the ordinary case B decides before A
//!   gives up.
//!
//! ### What "confirmed" means, and why it costs a turn
//!
//! Two readings were on the table. Reading the planted file back proves the
//! bytes arrived and says nothing about the model: the move exists so that the
//! *conversation* goes on over there, and a CLI that resumed a session and
//! answered from nothing would pass a byte check perfectly. So the card's first
//! turn on B is the proof — a **cloze test** on its own last words.
//! `challenge_of` takes a line the card itself wrote near the end of the
//! transcript as shipped; the prompt shows the line's first few words and asks
//! for the rest, from memory, with no tool calls; `held` checks the answer
//! against the line. A model without the history cannot finish a sentence it
//! never saw, and the transcript the CLI writes on B is where the answer is
//! read from (`answer_after`), so the check is the model's own words as
//! recorded rather than anything the front end reported.
//!
//! What it costs is less than it looks. The turn is a real one — the whole
//! context, read once — but that read is the one the card's *next* prompt on B
//! would have paid anyway, since the first turn after a transplant writes the
//! prompt cache from cold whatever it is about. What the check adds is a short
//! answer and the minute it takes. And the turn says the second thing that has
//! to be said: the card has moved, its paths are different, nothing it started
//! came with it. Both in one prompt, which is in the transcript for good.
//!
//! ### The code moves by git
//!
//! Not over the flyway, and that is decided rather than a gap. A card whose tree
//! is dirty, or whose commit is on no remote, is refused before anything leaves
//! (`tree_refusal`) — inventing a patch transport would be a second, worse git.
//! What travels is where the code *was* (`Code`), and B tells the card whether
//! its own checkout has that commit.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::fleet::Origin;

/// The word a wall announces in `Facts::can` when it takes cards moving in.
pub const WORD: &str = "move";

/// The most transcript one part carries. The wire's frame bound is 8 MB
/// (`wire::MAX_FRAME`) and a part is JSON inside JSON, which escapes every
/// quote; three megabytes stays inside the bound however quote-dense the
/// transcript, and moves in well under an exchange's twenty seconds over a
/// relay.
pub const PART_BYTES: usize = 3 * 1024 * 1024;

/// The largest transcript that moves. A card with a hundred megabytes of
/// conversation is one the CLI itself is compacting around, and this bounds
/// what an arriving wall holds in memory for a sender it trusts but should not
/// have to believe.
pub const MOST_BYTES: u64 = 96 * 1024 * 1024;

/// The most parts an offer may say it comes in — what the arriving wall
/// allocates for before a byte has arrived. Room for `MOST_BYTES` cut finer
/// than this wall cuts.
pub const MOST_PARTS: u32 = 256;

/// How long B waits for the card to answer its check before calling the move
/// failed. Resuming a session with a large context and answering one question
/// is a minute or two; this leaves room for a `529` and the retry after it.
pub const CONFIRM_WITHIN_MS: i64 = 8 * 60_000;

/// How long A waits to hear how the move ended before keeping its card. Longer
/// than B's own deadline so that, ordinarily, B has decided and said so first.
pub const SETTLE_WITHIN_MS: i64 = 12 * 60_000;

/// How long an arriving card's parts are kept while the rest are on their way.
pub const PARTS_WITHIN_MS: i64 = 5 * 60_000;

/// Where the code was when the card left: the commit its tree was at, and the
/// branch, if it was on one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Code {
    pub sha: String,
    #[serde(default)]
    pub branch: Option<String>,
}

/// A card this one opened on another wall, which goes on being its child.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Afar {
    pub host: String,
    pub card: String,
}

/// Everything about a card that has to arrive for it to be the same card —
/// and nothing about the machine it left.
///
/// Not the account (a sign-in on one machine; B's ladder picks), not a secret
/// grant (credentials never travel), not its place on A's glass. **The id and
/// the session are kept**: a card is matched by its id everywhere a wall asks
/// who it is (`fleet::may_reach`, `here::is_child_of`), and a handle that kept
/// working after the move is what lets an orchestrator go on talking to it
/// without knowing it moved.
///
/// `#[serde(default)]` on everything a later build might add or a sender might
/// not know, for `fleet::Facts`' reason: two walls are never upgraded together.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Moving {
    pub card: String,
    pub session: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub named: bool,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    /// The permission mode — `gears.md`'s gear.
    #[serde(default)]
    pub gear: Option<String>,
    #[serde(default)]
    pub worktree: Option<String>,
    /// The territory, by the name both walls know it by (`here::territories`).
    pub territory: String,
    pub code: Code,
    /// Whom it answers to, if anybody: the wall and card that asked for it
    /// (`flyway_birth`), or the card on A that opened it.
    #[serde(default)]
    pub origin: Option<Origin>,
    /// Cards on A it opened, which stay on A and go on being its children.
    #[serde(default)]
    pub children: Vec<String>,
    /// Cards on other walls it opened (`flyway_child`).
    #[serde(default)]
    pub afar: Vec<Afar>,
    /// How many parts the transcript comes in, and how many bytes they make.
    pub parts: u32,
    pub bytes: u64,
}

/// What two walls say about a move. Never gossiped, never relayed: each is
/// said to the one wall it is for, in an exchange of its own, and answered on
/// the same stream — `tail.rs`'s shape, for `tail.rs`'s reason. A transcript
/// re-said to every peer on every tick would be the conversation gossiped.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "msg", rename_all = "snake_case")]
pub enum MoveMsg {
    /// A → B: may this card come? The rows and the transcript's size, not its
    /// bytes, so a refusal costs nothing shipped.
    MoveOffer { id: String, card: Moving },
    /// A → B: one part of the transcript, in order or not.
    MovePart { id: String, index: u32, text: String },
    /// B → A, on the same stream: where the move stands. `have` counts parts.
    MoveAnswer {
        id: String,
        ok: bool,
        #[serde(default)]
        have: u32,
        #[serde(default)]
        why: Option<String>,
    },
    /// B → A, pushed until answered: the card resumed on B and finished its
    /// own line (`ok`), or did not — said with why.
    MoveSettled {
        id: String,
        card: String,
        ok: bool,
        #[serde(default)]
        why: Option<String>,
    },
    /// A → B, on the same stream as a settlement: what A did with its copy.
    /// `released: false` means A has the card and is keeping it, which is B's
    /// one licence to take its own copy away.
    MoveReleased {
        id: String,
        released: bool,
        #[serde(default)]
        why: Option<String>,
    },
}

/// The words `frame.rs` must know, so a malformed move frame is told apart from
/// a newer build's word.
pub const TAGS: [&str; 5] = ["move_offer", "move_part", "move_answer", "move_settled", "move_released"];

/* ── the transcript, in parts ─────────────────────────────────────────────── */

/// The transcript as parts of at most `PART_BYTES`, cut at the end of a line
/// wherever one is in reach and on a character boundary otherwise. Joined in
/// order, they are the transcript byte for byte — which is the only property
/// that matters, and the test holds it.
pub fn split(text: &str) -> Vec<String> {
    split_at(text, PART_BYTES)
}

fn split_at(text: &str, most: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut start = 0;
    while start < text.len() {
        let mut end = (start + most).min(text.len());
        if end < text.len() {
            /* A character boundary first — the search below slices — and never
               back to where the part began: a part narrower than one
               character takes the whole character rather than nothing. */
            while end > start && !text.is_char_boundary(end) {
                end -= 1;
            }
            if end == start {
                end = start + 1;
                while !text.is_char_boundary(end) {
                    end += 1;
                }
            } else if let Some(i) = text[start..end].rfind('\n') {
                if i > 0 {
                    end = start + i + 1;
                }
            }
        }
        out.push(text[start..end].to_string());
        start = end;
    }
    out
}

/// A card's transcript arriving in parts.
#[derive(Debug, Clone)]
pub struct Arriving {
    pub from: String,
    pub card: Moving,
    pub since: i64,
    parts: Vec<Option<String>>,
}

impl Arriving {
    /// An offer, as the arriving wall will hold it — or why it cannot.
    pub fn new(from: &str, card: Moving, since: i64) -> Result<Self, String> {
        if card.parts == 0 {
            return Err("the offer says the conversation comes in no parts at all".into());
        }
        if card.bytes > MOST_BYTES {
            return Err(format!(
                "the conversation is {} MB, and a card moves with at most {} MB of it — it is \
                 probably one to hand off rather than move",
                card.bytes / (1024 * 1024),
                MOST_BYTES / (1024 * 1024)
            ));
        }
        /* Every part carries at least a byte, and there is a ceiling however
           the bytes are cut — the count is what this wall allocates for, so a
           count is somebody else's idea of how much it should hold open. */
        if card.parts as u64 > card.bytes || card.parts > MOST_PARTS {
            return Err(format!("{} parts for {} bytes is not a conversation this wall will hold", card.parts, card.bytes));
        }
        Ok(Self { from: from.to_string(), parts: vec![None; card.parts as usize], card, since })
    }

    /// One part in. Returns how many are now held. A part sent twice is the
    /// same part; one out of range or too large is refused.
    pub fn add(&mut self, index: u32, text: String) -> Result<u32, String> {
        let Some(slot) = self.parts.get_mut(index as usize) else {
            return Err(format!("part {index} of {} does not exist", self.card.parts));
        };
        if text.len() > PART_BYTES {
            return Err(format!("part {index} is larger than a part is"));
        }
        *slot = Some(text);
        Ok(self.have())
    }

    pub fn have(&self) -> u32 {
        self.parts.iter().filter(|p| p.is_some()).count() as u32
    }

    /// The whole transcript, once every part is in — or why the parts do not
    /// make the conversation the offer described.
    pub fn whole(&self) -> Option<Result<String, String>> {
        if self.have() < self.card.parts {
            return None;
        }
        let text: String = self.parts.iter().flatten().map(String::as_str).collect();
        Some(if text.len() as u64 == self.card.bytes {
            Ok(text)
        } else {
            Err(format!("the parts make {} bytes where the offer said {}", text.len(), self.card.bytes))
        })
    }
}

/// What to do with an arriving conversation, given what is already at the place
/// it goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Plant {
    /// Nothing there, or an earlier state of this very conversation: write it.
    Write,
    /// The same bytes are already there — the two walls share a disk, or a
    /// repeat. Nothing to do.
    Same,
    /// Something else is there, and it is not ours to overwrite.
    Refuse,
}

/// Whether the arriving conversation may go where a file already is.
///
/// **A card moving back to a wall it left finds its own older self there**: the
/// wall released it but never deleted the file, and the conversation has grown
/// on the other machine since. A transcript is appended to and never rewritten,
/// so that older self is a byte-for-byte prefix of what arrives, and putting
/// the longer one in its place loses nothing. Anything else — a file that is
/// not a prefix — is a conversation that went somewhere this one did not, and
/// it is refused rather than overwritten: never deleting is the rule that keeps
/// a card from ending up nowhere.
pub fn plant_over(there: Option<&[u8]>, arriving: &[u8]) -> Plant {
    match there {
        None => Plant::Write,
        Some(t) if t == arriving => Plant::Same,
        Some(t) if arriving.starts_with(t) => Plant::Write,
        Some(_) => Plant::Refuse,
    }
}

/* ── reading a transcript ─────────────────────────────────────────────────── */

/// Each record of a transcript that is part of the conversation — not a
/// sidechain's (a subagent's), which the card itself never said.
fn records(jsonl: &str) -> impl DoubleEndedIterator<Item = Value> + '_ {
    jsonl
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|r| r.get("isSidechain").and_then(Value::as_bool) != Some(true))
}

/// The text of one record, if it is of that role and says something in words.
/// A prompt is a bare string from the TUI and a text block from the SDK
/// (`history.ts`); a tool result is a `user` record with no text block, and is
/// nobody's words.
fn said(rec: &Value, role: &str) -> Option<String> {
    if rec.get("type").and_then(Value::as_str) != Some(role) {
        return None;
    }
    if rec.get("isMeta").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let content = rec.get("message")?.get("content")?;
    let text = match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    (!text.trim().is_empty()).then_some(text)
}

/// A line the card wrote, cut in two: the words the check shows it, and the
/// rest, which it must give back.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Challenge {
    pub cue: String,
    pub rest: String,
}

/// How many words of the line the prompt shows.
const CUE_WORDS: usize = 4;

/// The fewest characters (normalized) the hidden half must have — short enough
/// that most of a card's lines qualify, long enough that nobody guesses it.
const REST_LEAST: usize = 28;

/// The line the check will ask for: the last one in the card's latest words
/// that is long enough to test and is prose rather than a table, a fence or a
/// heading — a cloze on `| --- |` proves nothing. Searched from the end, so it
/// is the freshest thing in the card's context: the one part of a conversation
/// a compaction never takes.
pub fn challenge_of(jsonl: &str) -> Option<Challenge> {
    for rec in records(jsonl).rev() {
        let Some(text) = said(&rec, "assistant") else { continue };
        for line in text.lines().rev() {
            let line = line.trim();
            if line.starts_with('|') || line.starts_with("```") || line.starts_with('#') || line.contains("move check") {
                continue;
            }
            let words: Vec<&str> = line.split_whitespace().collect();
            if words.len() < CUE_WORDS + 4 {
                continue;
            }
            let cue = words[..CUE_WORDS].join(" ");
            let rest = words[CUE_WORDS..].join(" ");
            if normalize(&rest).chars().count() >= REST_LEAST {
                return Some(Challenge { cue, rest });
            }
        }
    }
    None
}

/// The card's answer to the prompt carrying `token`: everything it said in
/// words after the last prompt that carries it, up to the next prompt
/// somebody else gave it. `None` if it has said nothing since — a turn that
/// failed, which the deadline settles rather than this.
pub fn answer_after(jsonl: &str, token: &str) -> Option<String> {
    let recs: Vec<Value> = records(jsonl).collect();
    let at = recs.iter().rposition(|r| said(r, "user").is_some_and(|t| t.contains(token)))?;
    let mut out: Vec<String> = Vec::new();
    for r in &recs[at + 1..] {
        if said(r, "user").is_some() {
            break;
        }
        if let Some(t) = said(r, "assistant") {
            out.push(t);
        }
    }
    (!out.is_empty()).then(|| out.join("\n"))
}

/// Whether anybody has spoken to the card since it answered the prompt carrying
/// `token` — the one thing that decides whether a copy that turned out not to
/// be wanted can be taken away without losing what somebody said to it.
pub fn untouched_since(jsonl: &str, token: &str) -> bool {
    let recs: Vec<Value> = records(jsonl).collect();
    let Some(at) = recs.iter().rposition(|r| said(r, "user").is_some_and(|t| t.contains(token))) else {
        return false;
    };
    !recs[at + 1..].iter().any(|r| said(r, "user").is_some())
}

/// Lowercase letters and digits, one space between words — so a line quoted
/// back with its bold, its backticks or a dash in a different place is still
/// the line.
pub fn normalize(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut gap = false;
    for ch in s.chars() {
        if ch.is_alphanumeric() {
            if gap && !out.is_empty() {
                out.push(' ');
            }
            gap = false;
            out.extend(ch.to_lowercase());
        } else {
            gap = true;
        }
    }
    out
}

/// Whether the answer gives back the hidden half of the line.
///
/// Not equality: a model quoting itself drops a comma or a closing bracket, and
/// a check that failed on that would keep cards on A that had moved perfectly.
/// What it must contain is one unbroken run of the line's own words — at least
/// six-tenths of it, and never less than `REST_LEAST` characters — which a
/// model that never saw the sentence does not produce by luck.
pub fn held(c: &Challenge, answer: &str) -> bool {
    let rest: Vec<char> = normalize(&c.rest).chars().collect();
    let said: Vec<char> = normalize(answer).chars().collect();
    if rest.is_empty() || said.is_empty() {
        return false;
    }
    let need = (rest.len() * 6 / 10).max(REST_LEAST).min(rest.len());
    longest_common_run(&rest, &said) >= need
}

/// The longest run the two have in common, by characters.
fn longest_common_run(a: &[char], b: &[char]) -> usize {
    let mut best = 0;
    let mut prev = vec![0usize; b.len() + 1];
    for &x in a {
        let mut row = vec![0usize; b.len() + 1];
        for (j, &y) in b.iter().enumerate() {
            if x == y {
                row[j + 1] = prev[j] + 1;
                best = best.max(row[j + 1]);
            }
        }
        prev = row;
    }
    best
}

/* ── what the card is told ────────────────────────────────────────────────── */

/// What B tells the card in the turn that proves it moved.
pub struct Arrival<'a> {
    pub from: &'a str,
    pub to: &'a str,
    pub territory: &'a str,
    /// Where it runs now — the root, or its worktree on this machine.
    pub dir: &'a str,
    pub code: &'a Code,
    /// Whether this checkout already contains the commit it left at — `None`
    /// when that could not be asked.
    pub has_code: Option<bool>,
    pub token: &'a str,
    pub cue: &'a str,
}

/// The prompt. Under the wall's own envelope (`relay::RELAY_MARK`, "from the
/// wall"), which the panel already draws as nobody's words, so it does not
/// read as something the person typed.
///
/// It says what moved and what did not before it asks anything, because the
/// first thing a card does after a move is reach for a path on the old machine
/// or a server it started there — and it asks for no tools and no work, since
/// a check that started editing the repository on B would be a move that did
/// something before anybody agreed it had happened.
pub fn confirm_prompt(mark: &str, a: &Arrival) -> String {
    let short: String = a.code.sha.chars().take(10).collect();
    let on = match &a.code.branch {
        Some(b) => format!("commit `{short}` on `{b}`"),
        None => format!("commit `{short}`"),
    };
    let code = match a.has_code {
        Some(true) => format!("Your work was at {on} on {}, and this checkout has it.", a.from),
        Some(false) => format!(
            "Your work was at {on} on {}, and **this checkout does not have it yet** — fetch it \
             (and check nothing else here is using this tree) before you rely on what is on disk.",
            a.from
        ),
        None => format!("Your work was at {on} on {}; check this checkout has it before you rely on it.", a.from),
    };
    format!(
        "{mark} from the wall —\n\n\
         **You have been moved to another machine.** This conversation ran on {from} and now runs \
         on {to}, in its {territory} territory at `{dir}`. Everything you remember happened on \
         {from}: a path you used there may not exist here, and nothing you started there — a \
         server, a background command, a watcher — came with you. The code moved by git. {code}\n\n\
         First, a check that your history came with you. One line you wrote near the end of your \
         last message begins:\n\n> {cue} …\n\nReply with that whole line, word for word, after \
         `line:` — from memory, with no tool calls; the wall compares it with what you wrote. \
         Then stop, start no work, and wait to be spoken to.\n\n({token})",
        from = a.from,
        to = a.to,
        territory = a.territory,
        dir = a.dir,
        cue = a.cue,
        token = a.token,
    )
}

/// The token a check's prompt carries, by which its answer is found.
pub fn token_for(request: &str) -> String {
    let short: String = request.chars().filter(|c| c.is_ascii_alphanumeric()).take(12).collect();
    format!("move check {short}")
}

/* ── whether the code can move by git ─────────────────────────────────────── */

/// Why this tree cannot move by git, or `None`.
///
/// `status` is `git status --porcelain` with untracked files counted —
/// untracked work is uncommitted work, and `-uno` (which the actions poll uses)
/// would let a new file stay behind. `on_remote` is `git branch -r --contains
/// HEAD`: the commit has to be somewhere the other machine can fetch it from,
/// and asking which remote branches contain it is the one question that works
/// with an upstream and without — a worktree branch is made `--no-track`
/// (`worktree.md`), so "ahead of upstream" would say nothing about it.
pub fn tree_refusal(status: &str, on_remote: &str, sha: &str) -> Option<String> {
    let dirty: Vec<&str> = status.lines().filter(|l| !l.trim().is_empty()).collect();
    if !dirty.is_empty() {
        let shown: Vec<&str> = dirty.iter().take(5).map(|l| l.trim()).collect();
        let more = if dirty.len() > 5 { format!(" and {} more", dirty.len() - 5) } else { String::new() };
        return Some(format!(
            "its tree has uncommitted work ({}{more}), and the code moves by git, not over the \
             flyway — commit it and push, then move the card",
            shown.join(", ")
        ));
    }
    if on_remote.lines().all(|l| l.trim().is_empty()) {
        let short: String = sha.chars().take(10).collect();
        return Some(format!(
            "commit {short} is on no remote branch, so the other machine has no way to get it — \
             push it, then move the card"
        ));
    }
    None
}

/* ── settling ─────────────────────────────────────────────────────────────── */

/// What the sending wall has decided about its copy — `flyway_move.outcome`
/// for a move out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Out {
    /// Shipped, or shipping; the card is frozen here and not woken.
    InFlight,
    /// The card answered with its history on the other wall, and this copy is
    /// closed — never deleted.
    Released,
    /// This wall has the card and is keeping it: the other wall said it failed,
    /// or never said anything in time.
    Kept,
}

impl Out {
    pub fn word(self) -> Option<&'static str> {
        match self {
            Out::InFlight => None,
            Out::Released => Some("released"),
            Out::Kept => Some("kept"),
        }
    }

    pub fn from_word(w: Option<&str>) -> Self {
        match w {
            None => Out::InFlight,
            Some("released") => Out::Released,
            /* Anything else is a word this build did not write, and the safe
               reading of an unknown decision is that this wall still has the
               card. */
            Some(_) => Out::Kept,
        }
    }
}

/// What the sending wall does with a settlement: its new state, and whether it
/// tells the other wall it let its copy go.
///
/// The decision is made once. A repeat — the other wall pushing again because
/// the answer was lost — gets the same answer, and a confirmation that arrives
/// after this wall gave up is answered `Kept`, which is what makes the other
/// wall take its copy away: two walls never both let the card go.
pub fn settle_out(now: Option<Out>, ok: bool) -> (Out, bool) {
    match (now, ok) {
        (None, _) => (Out::Kept, false),
        (Some(Out::InFlight), true) => (Out::Released, true),
        (Some(Out::InFlight), false) => (Out::Kept, false),
        (Some(Out::Released), _) => (Out::Released, true),
        (Some(Out::Kept), _) => (Out::Kept, false),
    }
}

/// Whether a move out has been in flight long enough to give up on — the card
/// is kept, unfrozen, and a late confirmation is answered `Kept`.
pub fn given_up(now: i64, at: i64) -> bool {
    now.saturating_sub(at) > SETTLE_WITHIN_MS
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn line(v: Value) -> String {
        serde_json::to_string(&v).unwrap()
    }

    fn user(text: &str) -> String {
        line(json!({ "type": "user", "message": { "role": "user", "content": text } }))
    }

    fn assistant(text: &str) -> String {
        line(json!({ "type": "assistant", "message": { "role": "assistant", "content": [{ "type": "text", "text": text }] } }))
    }

    fn tool_result() -> String {
        line(json!({ "type": "user", "message": { "role": "user", "content": [{ "type": "tool_result", "content": "ok" }] } }))
    }

    fn moving(parts: u32, bytes: u64) -> Moving {
        Moving {
            card: "c".into(),
            session: "s".into(),
            title: None,
            named: false,
            model: None,
            effort: None,
            gear: None,
            worktree: None,
            territory: "skein".into(),
            code: Code { sha: "abc".into(), branch: None },
            origin: None,
            children: vec![],
            afar: vec![],
            parts,
            bytes,
        }
    }

    /// Joined in order, the parts are the transcript byte for byte, whatever
    /// the lines and characters — including a line longer than a part and a
    /// character that a byte cut would split.
    #[test]
    fn parts_join_back_into_the_conversation_exactly() {
        let long = "é".repeat(40);
        let text = format!("one\ntwo three\n{long}\nfour\n\nfive");
        for most in [1, 2, 3, 5, 8, 64, 10_000] {
            let parts = split_at(&text, most);
            assert_eq!(parts.concat(), text, "at {most}");
            assert!(parts.iter().all(|p| !p.is_empty()));
            assert!(parts.iter().all(|p| p.len() <= most.max(2)), "a part never exceeds its size: {most}");
        }
        assert!(split("").is_empty());
        /* Cut at the ends of lines where one is in reach. */
        assert_eq!(split_at("aa\nbb\ncc\n", 7), vec!["aa\nbb\n", "cc\n"]);
    }

    /// Parts arrive in any order, a repeat is the same part, and the whole is
    /// only the whole when it is the size the offer said.
    #[test]
    fn an_arriving_conversation_is_whole_only_when_it_is_what_was_offered() {
        let text = "a\nbb\nccc\n";
        let parts = split_at(text, 4);
        let mut a = Arriving::new("lap", moving(parts.len() as u32, text.len() as u64), 0).unwrap();
        assert!(a.whole().is_none());
        for (i, p) in parts.iter().enumerate().rev() {
            a.add(i as u32, p.clone()).unwrap();
        }
        a.add(0, parts[0].clone()).unwrap();
        assert_eq!(a.whole(), Some(Ok(text.to_string())));
        assert!(a.add(99, "x".into()).is_err(), "a part that does not exist");

        let mut short = Arriving::new("lap", moving(1, 50), 0).unwrap();
        short.add(0, "only this".into()).unwrap();
        assert!(matches!(short.whole(), Some(Err(_))), "a size that does not match is refused");

        assert!(Arriving::new("lap", moving(0, 0), 0).is_err());
        assert!(Arriving::new("lap", moving(1, MOST_BYTES + 1), 0).is_err(), "too big to move");
        assert!(Arriving::new("lap", moving(10_000, 10), 0).is_err(), "more parts than the bytes need");
    }

    /// A card coming back finds its own older self, which it may replace; a
    /// conversation that went elsewhere is never overwritten.
    #[test]
    fn a_conversation_is_planted_over_only_its_own_earlier_self() {
        assert_eq!(plant_over(None, b"a\nb\n"), Plant::Write);
        assert_eq!(plant_over(Some(b"a\nb\n"), b"a\nb\n"), Plant::Same);
        assert_eq!(plant_over(Some(b"a\n"), b"a\nb\n"), Plant::Write, "it grew on the other wall");
        assert_eq!(plant_over(Some(b"a\nc\n"), b"a\nb\n"), Plant::Refuse, "it went somewhere else");
        assert_eq!(plant_over(Some(b"a\nb\nc\n"), b"a\nb\n"), Plant::Refuse, "the copy here is further on");
    }

    /// The check takes a line of the card's own prose from its latest words —
    /// not a table, a fence, a heading, a subagent's words or a line too short
    /// to test — and splits it into what is shown and what must come back.
    #[test]
    fn the_check_is_a_line_the_card_itself_wrote_last() {
        let sidechain = line(json!({ "type": "assistant", "isSidechain": true,
            "message": { "content": [{ "type": "text", "text": "a subagent wrote this line which the card never said at all" }] } }));
        let t = [
            user("do the thing"),
            assistant("An earlier reply that is long enough to be a line worth asking about."),
            tool_result(),
            assistant("All done. The migration rung is v49 and the lab wall has been walked up to it cleanly.\n\n| a | b |\n```\nok"),
            sidechain,
        ]
        .join("\n");
        let c = challenge_of(&t).unwrap();
        assert_eq!(c.cue, "All done. The migration");
        assert_eq!(c.rest, "rung is v49 and the lab wall has been walked up to it cleanly.");
        assert_eq!(challenge_of(&[user("hi"), assistant("ok")].join("\n")), None, "nothing long enough to test");
        assert_eq!(challenge_of("not json\n\n"), None);
    }

    /// A model that has the line gives it back, with its punctuation however
    /// it likes; a model that does not, does not — not even with the cue's own
    /// words repeated, and not with a sentence of its own on the same subject.
    #[test]
    fn the_answer_holds_only_when_it_carries_the_rest_of_the_line() {
        let c = Challenge { cue: "All done. The migration".into(), rest: "rung is v49 and the lab wall has been walked up to it cleanly.".into() };
        assert!(held(&c, "line: All done. The migration rung is v49 and the lab wall has been walked up to it cleanly."));
        assert!(held(&c, "line: All done — the migration **rung is v49** and the lab wall has been walked up to it cleanly"));
        assert!(!held(&c, "line: All done. The migration"));
        assert!(!held(&c, "line: All done. The migration is finished and everything is committed and pushed."));
        assert!(!held(&c, ""));
        /* A line quoted with its tail dropped still holds; one guessed at does not. */
        assert!(held(&c, "line: All done. The migration rung is v49 and the lab wall has been walked"));
    }

    /// The answer is what the card said after the prompt that carries the token
    /// and before anybody spoke to it again — read off the transcript the CLI
    /// wrote, never off the front end.
    #[test]
    fn the_answer_is_read_after_the_prompt_that_asked_for_it() {
        let token = token_for("1a2b3c4d-0000");
        assert_eq!(token, "move check 1a2b3c4d0000");
        let t = [
            assistant("before"),
            user(&format!("[skein relay] from the wall — please ({token})")),
            assistant("line: the one I wrote"),
            tool_result(),
            assistant("and more"),
            user("now something else"),
            assistant("unrelated"),
        ]
        .join("\n");
        assert_eq!(answer_after(&t, &token).as_deref(), Some("line: the one I wrote\nand more"));
        assert!(!untouched_since(&t, &token), "somebody spoke to it since");
        let quiet = [user(&format!("check ({token})")), assistant("line: x")].join("\n");
        assert!(untouched_since(&quiet, &token));
        assert_eq!(answer_after(&[user(&format!("({token})"))].join("\n"), &token), None, "a turn that never answered");
        assert_eq!(answer_after(&assistant("x"), &token), None);
        assert!(!untouched_since(&assistant("x"), &token), "no check at all is not untouched");
    }

    /// The prompt says it is from the wall, that the card moved and from where
    /// to where, what did not come with it, where the code is — and asks for
    /// the line with no tools and no work, carrying its token.
    #[test]
    fn the_prompt_says_what_moved_and_asks_for_nothing_but_the_line() {
        let code = Code { sha: "0123456789abcdef".into(), branch: Some("main".into()) };
        let a = Arrival {
            from: "LAPTOP",
            to: "DESK",
            territory: "skein",
            dir: "D:\\src\\skein",
            code: &code,
            has_code: Some(false),
            token: "move check abc",
            cue: "All done. The migration",
        };
        let p = confirm_prompt("[skein relay]", &a);
        assert!(p.starts_with("[skein relay] from the wall —"), "{p}");
        for want in ["LAPTOP", "DESK", "D:\\src\\skein", "0123456789", "`main`", "does not have it", "> All done. The migration …", "no tool calls", "start no work", "(move check abc)"] {
            assert!(p.contains(want), "missing {want:?}: {p}");
        }
        assert!(!p.contains("rung is v49"), "the hidden half is never in the prompt");
    }

    /// The code moves by git: uncommitted work refuses, untracked included, and
    /// so does a commit no remote has.
    #[test]
    fn a_tree_moves_only_when_git_can_carry_it() {
        assert_eq!(tree_refusal("", "  origin/main\n", "abc"), None);
        let why = tree_refusal(" M src/a.rs\n?? notes.md\n", "  origin/main\n", "abc").unwrap();
        assert!(why.contains("src/a.rs") && why.contains("notes.md") && why.contains("commit"), "{why}");
        let why = tree_refusal("", "\n", "0123456789abcdef").unwrap();
        assert!(why.contains("0123456789") && why.contains("push"), "{why}");
        let many: String = (0..9).map(|i| format!("?? f{i}\n")).collect();
        assert!(tree_refusal(&many, "origin/main", "x").unwrap().contains("and 4 more"));
    }

    /// **The one property the whole design answers to**: a settlement never has
    /// both walls letting the card go. Walked over every state and both
    /// answers, including the repeats and the confirmation that came too late.
    #[test]
    fn two_walls_never_both_let_a_card_go() {
        for now in [None, Some(Out::InFlight), Some(Out::Released), Some(Out::Kept)] {
            for ok in [true, false] {
                let (next, released) = settle_out(now, ok);
                /* B takes its copy away only on `released: false`; A has let its
                   copy go only in `Released`. They must never coincide. */
                assert_eq!(released, next == Out::Released, "{now:?} {ok}");
                if !ok {
                    assert_ne!((now, next), (Some(Out::InFlight), Out::Released), "a failed check never releases");
                }
                /* And the decision, once made, is the answer to every repeat. */
                assert_eq!(settle_out(Some(next), ok), (next, released));
            }
        }
        assert_eq!(settle_out(Some(Out::InFlight), true), (Out::Released, true));
        assert_eq!(settle_out(Some(Out::Kept), true), (Out::Kept, false), "too late: kept, and B's copy goes");
        assert_eq!(settle_out(None, true), (Out::Kept, false), "a move this wall never made is not released");
    }

    #[test]
    fn the_decision_round_trips_through_its_word_and_an_unknown_word_keeps() {
        for o in [Out::InFlight, Out::Released, Out::Kept] {
            assert_eq!(Out::from_word(o.word()), o);
        }
        assert_eq!(Out::from_word(Some("a word from a newer build")), Out::Kept);
        assert!(!given_up(SETTLE_WITHIN_MS, 0) && given_up(SETTLE_WITHIN_MS + 1, 0));
        assert!(CONFIRM_WITHIN_MS < SETTLE_WITHIN_MS, "B decides before A gives up");
    }

    /// Every word a move frame writes is one `frame.rs` is told about.
    #[test]
    fn the_tags_are_the_words_the_messages_write() {
        let written: Vec<String> = [
            MoveMsg::MoveOffer { id: "i".into(), card: moving(1, 1) },
            MoveMsg::MovePart { id: "i".into(), index: 0, text: String::new() },
            MoveMsg::MoveAnswer { id: "i".into(), ok: true, have: 0, why: None },
            MoveMsg::MoveSettled { id: "i".into(), card: "c".into(), ok: true, why: None },
            MoveMsg::MoveReleased { id: "i".into(), released: true, why: None },
        ]
        .iter()
        .map(|m| serde_json::to_value(m).unwrap()["msg"].as_str().unwrap().to_string())
        .collect();
        assert_eq!(written, TAGS.map(String::from).to_vec());
        /* And an offer from a build with fewer fields still reads. */
        let sparse = json!({ "msg": "move_offer", "id": "i", "card": {
            "card": "c", "session": "s", "territory": "skein", "code": { "sha": "x" }, "parts": 1, "bytes": 3 } });
        assert!(serde_json::from_value::<MoveMsg>(sparse).is_ok());
    }
}
