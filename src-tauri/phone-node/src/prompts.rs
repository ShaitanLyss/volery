//! What a wall is waiting on a person for, read off its cards digest for a
//! phone screen.
//!
//! The digest is the whole of what a phone knows about a wall's cards, and it
//! already carries every kind of thing that parks: an agent's `ask_user`
//! (`asks`), the questions filed into its pile while nobody was there
//! (`filed`), Volery's own removal and close confirmations (`removals`,
//! `closings`), every other confirmation (`confirms` — a pull request, an Asana
//! write, a credential lend), and the notice queue (`notices`).
//!
//! ### Why this reader is here rather than in Kotlin
//!
//! Because it is the half that can be tested. The Android app has no test
//! source set and no runner on this machine; everything below is a pure fold
//! over JSON, and the crate's suites run on the phone itself (see
//! `build-android.sh test`). Kotlin's job is to draw the rows and send the
//! answer back.
//!
//! The vocabulary is the far wall's, not a second taxonomy: this reads the
//! fields `shadow.ts::digestOf` publishes and composes a small-screen reading
//! from them, as `afar.ts` composes the desktop's from the same fields. It
//! decides nothing about whether a question may travel — its wall already
//! decided that by publishing it.
//!
//! ### What an answer names
//!
//! Every row carries the exact `answers` value its wall reads: a parked ask's
//! id, a notice behind `notice:`, or a pile row behind `deferred:`. The phone
//! sends that string and the answer text down the prompt wire, and the owning
//! wall hands it to the parked call or the pile exactly as a click there would.
//! The prefixes are `notice::AFAR_PREFIX` and `presence::AFAR_PREFIX`; they are
//! restated here because this crate cannot link the app crate, and
//! `test/afar.test.ts` / `test/filed.test.ts` read this file to hold them equal.

use serde_json::Value;

use flyway_core::clean;

/// The labels `remove.rs` reads a yes and a no from, verbatim. Restated for the
/// same reason as the prefixes above.
pub const DELETE_IT: &str = "delete it";
pub const KEEP_IT: &str = "keep it";
/// And `spawn.rs`'s two, for a close.
pub const CLOSE_IT: &str = "close it";
pub const LEAVE_IT: &str = "leave it open";
/// `notice::AFAR_ACK`.
pub const ACKNOWLEDGED: &str = "acknowledged";
/// `notice::AFAR_PREFIX`.
pub const NOTICE_PREFIX: &str = "notice:";
/// `presence::AFAR_PREFIX`.
pub const PILE_PREFIX: &str = "deferred:";
/// `asking.ts::SKIPPED`, for a question of several nobody answered.
pub const SKIPPED: &str = "skipped";
/// `asking.ts`'s opening for a reply of several questions.
const PREAMBLE: &str = "Answering each in turn:";

/// How a note *about* the call is set apart from the answer to it, and the
/// note a skipped slot owes. Both are `asking.ts`'s own strings: `answerNote`
/// cuts at this marker when the reply is read back off disk, so a different
/// one here would put Skein's words in the person's mouth in the transcript.
const ASIDE: &str = "\n\n— skein: ";
const SKIPPED_ASIDE: &str =
    "a question answered `skipped` was passed over, not decided, and a skip is not permission: \
     don't do anything it was gating. Carry on with what it doesn't block, say plainly what you \
     are holding and why, and ask again if you need it.";

/// As many as the digest itself carries, restated so a hostile snapshot cannot
/// make a phone draw more than a person could answer.
pub const ASKS_MOST: usize = 6;
pub const FILED_MOST: usize = 8;
pub const NOTICES_MOST: usize = 6;
pub const QUESTIONS_MOST: usize = 12;
pub const OPTIONS_MOST: usize = 24;

/// A question body is read on a phone, so it is capped at what one screenful
/// can hold; the wall's own cap is 2,000 and the two agree in practice.
const BODY_MOST: usize = 2_000;
const HEADER_MOST: usize = 120;
const LABEL_MOST: usize = 120;
const DETAIL_MOST: usize = 300;
const BODY_SUM_MOST: usize = 6_000;

/// What kind of thing is waiting, in the vocabulary the screen draws.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Kind {
    /// An agent's `ask_user`.
    Ask,
    /// A question filed into its wall's pile while nobody was there.
    Filed,
    /// Volery's own confirmation before a permanent delete.
    Removal,
    /// Volery's own confirmation before a card is taken off the wall.
    Close,
    /// Every other confirmation Volery composed — a pull request, an Asana
    /// write, a credential lend.
    Confirm,
    /// A card that finished, ended on a question, gave up, or said something
    /// itself. Informational; it may be acknowledged or replied to.
    Notice,
}

impl Kind {
    /// The word a screen heads a row with when the row has no header of its
    /// own. Never empty, so a row is never drawn with a blank line.
    pub fn word(self) -> &'static str {
        match self {
            Kind::Ask => "question",
            Kind::Filed => "left for you",
            Kind::Removal => "delete",
            Kind::Close => "close",
            Kind::Confirm => "confirm",
            Kind::Notice => "notice",
        }
    }

    /// Whether answering this starts work on the wall, which is what the
    /// screen says before a tap that a person may not expect to spend anything.
    pub fn starts_work(self) -> bool {
        matches!(self, Kind::Ask | Kind::Filed | Kind::Notice)
    }
}

/// One option a person may pick, as the wall's own question wrote it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Choice {
    pub label: String,
    /// The cost or the risk, one line. Empty when the question gave none.
    pub detail: String,
}

/// One question on a prompt: its header, its words, and what may be chosen.
/// No options means the answer is a sentence (a notice, or an agent's free-form
/// question), which is the same rule the desktop's panel draws by.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Question {
    pub header: String,
    pub body: String,
    pub options: Vec<Choice>,
    /// A design or a file is attached to this question on the owning wall, and
    /// this phone cannot draw it. Said rather than silently dropped.
    pub shows: bool,
}

/// One thing waiting on a person, flattened for the app.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Prompt {
    /// The card's id **on the wall that owns it** — what the answer addresses.
    pub card: String,
    pub title: String,
    pub kind: Kind,
    /// The exact `answers` value the owning wall reads.
    pub answers: String,
    /// How long it has been waiting, on the reading phone's own clock: the
    /// owner-clock difference plus the snapshot's age, so no two clocks are
    /// ever compared.
    pub waited_ms: u64,
    pub questions: Vec<Question>,
    /// For a notice that holds no turn open: the word that takes it down
    /// without saying anything (`notice::AFAR_ACK`). `None` on everything
    /// else, which is answered with words.
    pub ack: Option<String>,
}

impl Prompt {
    /// What a row says when it has room for one line: the first question's
    /// header, else its first sentence, else the card's own title.
    pub fn headline(&self) -> String {
        if let Some(q) = self.questions.first() {
            if !q.header.is_empty() {
                return q.header.clone();
            }
            let first = q.body.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
            if !first.is_empty() {
                return cut(first, HEADER_MOST);
            }
        }
        self.title.clone()
    }

    /// Whether this row can be answered by picking, rather than only by
    /// speaking a sentence. The screen uses it to decide whether to draw a
    /// field at all.
    pub fn pickable(&self) -> bool {
        self.questions.iter().any(|q| !q.options.is_empty())
    }
}

/// Read every prompt a digest carries, most useful first: a live question or
/// confirmation (the card is stopped now) oldest first, then the pile newest
/// first (an inbox), then the notices newest first (news).
///
/// `age_ms` is the digest's own age from publish, and the snapshot's `at` is
/// the owner's clock; `waited_ms` subtracts one owner-clock value from the
/// other and then adds the age, which is the arithmetic `shadow.ts::askedAt`
/// keeps for the same reason.
pub fn read(snapshot: &Value, age_ms: u64) -> Vec<Prompt> {
    let Some(cards) = snapshot.get("cards").and_then(Value::as_array) else {
        return Vec::new();
    };
    let at = snapshot.get("at").and_then(Value::as_i64);
    let mut prompts = Vec::new();
    for raw in cards {
        read_card(raw, at, age_ms, &mut prompts);
    }
    /* A live question first, then the pile, then the notices — and the pile is
       newest-first where a live question is oldest-first.
     *
     * This was one "blocking" group ordered by age, and a real wall showed why
     * that is wrong on a phone: the pile had accumulated every deferred question
     * for eight days, and the roster's three rows were three of them while a
     * question asked this minute sat below. A live question is somebody stopped
     * *now*; the pile is an inbox, and its newest row is the one still worth
     * reading. Notices last, newest first, because a notice is news. */
    let rank = |k: Kind| match k {
        Kind::Filed => 1,
        Kind::Notice => 2,
        _ => 0,
    };
    prompts.sort_by(|a, b| {
        rank(a.kind)
            .cmp(&rank(b.kind))
            .then_with(|| match rank(a.kind) {
                0 => b.waited_ms.cmp(&a.waited_ms),
                _ => a.waited_ms.cmp(&b.waited_ms),
            })
            .then_with(|| a.kind.cmp(&b.kind))
            .then_with(|| a.card.cmp(&b.card))
    });
    prompts
}

fn read_card(raw: &Value, at: Option<i64>, age_ms: u64, out: &mut Vec<Prompt>) {
    let Some(obj) = raw.as_object() else { return };
    let card = obj.get("id").and_then(Value::as_str).map(str::trim).unwrap_or("");
    if card.is_empty() {
        return;
    }
    let title = obj
        .get("title")
        .and_then(Value::as_str)
        .map(|t| cut(t, HEADER_MOST))
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "a card".to_string());

    let mut push =
        |kind: Kind, answers: String, since: Option<i64>, questions: Vec<Question>, ack: Option<String>| {
            if answers.is_empty() || questions.is_empty() {
                return;
            }
            out.push(Prompt {
                card: card.to_string(),
                title: title.clone(),
                kind,
                answers,
                waited_ms: waited(at, since, age_ms),
                questions,
                ack,
            });
        };

    /* An agent's parked questions. `ours` never travel here — a confirmation of
       Volery's own is in one of the four fields below, carrying its evidence. */
    for ask in arr(obj.get("asks")).take(ASKS_MOST) {
        let Some(answers) = text(ask.get("askId"), 80) else { continue };
        let since = ask.get("since").and_then(Value::as_i64);
        let mut questions = read_questions(ask.get("questions"));
        /* An ask the digest carried without words of its own is still an ask:
           the card is stopped, and the roster's own count says so. Dropping it
           left a card reading "1 question waiting" with nothing anywhere to
           answer, which is worse than a question that has to be asked for. */
        if questions.is_empty() {
            questions.push(Question {
                header: String::new(),
                body: "This card is asking you something, but its words did not reach this phone. \
                       Answer in your own words, or open the card on the wall to read it."
                    .to_string(),
                options: Vec::new(),
                shows: false,
            });
        }
        push(Kind::Ask, answers, since, questions, None);
    }

    /* The pile. Absent and `null` both mean this wall has not said (the latter
       is a wall that has just started and has not read its pile yet), which is
       not the same as an empty pile and must not be drawn as one either way —
       nothing to draw is what it is. */
    for row in arr(obj.get("filed")).take(FILED_MOST) {
        let Some(row_id) = text(row.get("askId").or_else(|| row.get("id")), 80) else { continue };
        let since = row.get("since").or_else(|| row.get("askedAt")).and_then(Value::as_i64);
        let questions = read_questions(row.get("questions"));
        push(Kind::Filed, format!("{PILE_PREFIX}{row_id}"), since, questions, None);
    }

    for removal in arr(obj.get("removals")).take(ASKS_MOST) {
        let Some(answers) = text(removal.get("askId"), 80) else { continue };
        if let Some(q) = removal_question(removal.get("removal")) {
            push(Kind::Removal, answers, removal.get("since").and_then(Value::as_i64), vec![q], None);
        }
    }

    for closing in arr(obj.get("closings")).take(ASKS_MOST) {
        let Some(answers) = text(closing.get("askId"), 80) else { continue };
        if let Some(q) = closing_question(closing.get("closing")) {
            push(Kind::Close, answers, closing.get("since").and_then(Value::as_i64), vec![q], None);
        }
    }

    for confirm in arr(obj.get("confirms")).take(ASKS_MOST) {
        let Some(answers) = text(confirm.get("askId"), 80) else { continue };
        if let Some(q) = confirm_question(confirm.get("confirm")) {
            push(Kind::Confirm, answers, confirm.get("since").and_then(Value::as_i64), vec![q], None);
        }
    }

    for notice in arr(obj.get("notices")).take(NOTICES_MOST) {
        let Some(id) = text(notice.get("id"), 80) else { continue };
        /* A notice holding its card's turn open is answered by its ask id, into
           the call, exactly as a question is. Any other names itself with the
           prefix and takes an acknowledgement or a follow-up. */
        let ask = text(notice.get("askId"), 80);
        let ack = if ask.is_none() { Some(ACKNOWLEDGED.to_string()) } else { None };
        let answers = match ask {
            Some(ask) => ask,
            None => format!("{NOTICE_PREFIX}{id}"),
        };
        let said = text(notice.get("text"), BODY_MOST).unwrap_or_default();
        let kind = text(notice.get("kind"), 20).unwrap_or_default();
        let body = if said.trim().is_empty() { notice_fallback(&kind).to_string() } else { said };
        let since = notice.get("raisedAt").and_then(Value::as_i64);
        push(
            Kind::Notice,
            answers,
            since,
            vec![Question { header: String::new(), body: cut(&body, BODY_MOST), options: Vec::new(), shows: false }],
            ack,
        );
    }
}

/// One parked question's words, capped for a small screen. A question with no
/// readable `question` still gets a row: the header or the card title names it,
/// and a person can at least see that something is being asked.
fn read_questions(raw: Option<&Value>) -> Vec<Question> {
    let mut out = Vec::new();
    let mut spent = 0usize;
    for q in arr(raw).take(QUESTIONS_MOST) {
        let Some(obj) = q.as_object() else { continue };
        let header = text(obj.get("header"), HEADER_MOST).unwrap_or_default();
        let body = text(obj.get("question"), BODY_MOST).unwrap_or_default();
        let mut options = Vec::new();
        for o in arr(obj.get("options")).take(OPTIONS_MOST) {
            let Some(label) = text(o.get("label"), LABEL_MOST) else { continue };
            options.push(Choice {
                label,
                detail: text(o.get("detail"), DETAIL_MOST).unwrap_or_default(),
            });
        }
        /* A question with options and no words is a real choice, so it is
           kept: the labels are the question. One with neither is nothing. */
        if header.is_empty() && body.is_empty() && options.is_empty() {
            continue;
        }
        if spent + body.chars().count() > BODY_SUM_MOST {
            break;
        }
        spent += body.chars().count();
        out.push(Question { header, body, options, shows: obj.get("shows").and_then(Value::as_bool).unwrap_or(false) });
    }
    out
}

/* ── the four compositions Volery wrote the question for ───────────────── */

fn removal_question(raw: Option<&Value>) -> Option<Question> {
    let r = raw?.as_object()?;
    let machine = text(r.get("machine"), 80)?;
    let reason = text(r.get("reason"), BODY_MOST).unwrap_or_default();
    let targets = r.get("targets").and_then(Value::as_array)?;
    if targets.is_empty() {
        return None;
    }
    let mut lines = vec![format!(
        "A card on {machine} wants to delete {} — on {machine}'s disk, not this phone's.",
        if targets.len() == 1 { "this".to_string() } else { format!("these {}", targets.len()) }
    )];
    for t in targets.iter().take(8) {
        lines.push(String::new());
        lines.extend(described(t, &machine));
    }
    if targets.len() > 8 {
        lines.push(format!("…and {} more paths.", targets.len() - 8));
    }
    if !reason.is_empty() {
        lines.push(String::new());
        lines.push(format!("Its reason: {reason}"));
    }
    lines.push(String::new());
    lines.push(
        "This is permanent. It is not moved to a recycle bin and nothing can bring it back. \
         The wall checks again at the moment of deleting, so what you are approving is what is \
         described here."
            .to_string(),
    );
    Some(Question {
        header: cut(&format!("delete on {machine}"), HEADER_MOST),
        body: cut(&lines.join("\n"), BODY_MOST),
        options: vec![
            Choice { label: DELETE_IT.to_string(), detail: format!("Gone for good, from {machine}.") },
            Choice { label: KEEP_IT.to_string(), detail: "Nothing is touched.".to_string() },
        ],
        shows: false,
    })
}

/// One target's lines, every one a reading of that disk. `afar.ts::described`
/// is the desktop's fuller version; this keeps what decides a delete on a small
/// screen — what it is, how big, and the three ways it can cost something.
fn described(t: &Value, machine: &str) -> Vec<String> {
    let Some(o) = t.as_object() else { return Vec::new() };
    let Some(path) = text(o.get("path"), 1_000) else { return Vec::new() };
    let kind = text(o.get("kind"), 20).unwrap_or_else(|| "path".into());
    let entries = o.get("entries").and_then(Value::as_u64).unwrap_or(0);
    let bytes = o.get("bytes").and_then(Value::as_u64).unwrap_or(0);
    let capped = o.get("capped").and_then(Value::as_bool).unwrap_or(false);
    let floor = if capped { "more than " } else { "" };
    let size = match kind.as_str() {
        "directory" => format!("{floor}{} in {floor}{} {}", human_size(bytes), entries, if entries == 1 { "file" } else { "files" }),
        "link" => "a link — the link goes, not what it points at".to_string(),
        _ => human_size(bytes),
    };
    let mut lines = vec![path, format!("a {kind}, {size}")];
    if o.get("own").and_then(Value::as_bool) == Some(false) {
        lines.push("outside the card's own working tree".to_string());
    }
    let repo = o.get("repo").and_then(Value::as_bool).unwrap_or(false);
    let tracked = o.get("tracked").and_then(Value::as_u64).unwrap_or(0);
    lines.push(if !repo {
        "not in a git work tree — nothing here comes back from a commit".into()
    } else if tracked > 0 {
        format!("git tracks {tracked} {} under it", if tracked == 1 { "file" } else { "files" })
    } else {
        "in a git work tree but untracked — git has no copy of any of it".into()
    });
    let writers = names(o.get("writers"));
    if !writers.is_empty() {
        lines.push(format!("other cards on {machine} have written in here: {writers}"));
    }
    let servers = names(o.get("servers"));
    if !servers.is_empty() {
        lines.push(format!("a dev server is running out of this tree: {servers}"));
    }
    if let Some(repos) = o.get("repos").and_then(Value::as_array) {
        for repo in repos {
            let path = text(repo.get("path"), 1_000).unwrap_or_default();
            if repo.get("worktree").and_then(Value::as_bool) == Some(true) {
                lines.push(format!("{path} is a linked worktree; its commits live elsewhere, untouched"));
            } else {
                let remotes = names(repo.get("remotes"));
                lines.push(format!("{path} is pushed to {remotes} with nothing unpushed"));
            }
        }
    }
    lines
}

fn closing_question(raw: Option<&Value>) -> Option<Question> {
    let c = raw?.as_object()?;
    let machine = text(c.get("machine"), 80)?;
    let card = named(c.get("card"))?;
    let by = named(c.get("by"))?;
    let itself = card.1 == by.1;
    let why = text(c.get("why"), BODY_MOST);
    let mut lines = vec![if itself {
        format!("{} ({}) is asking to be closed — it says its work is done.", card.0, card.1)
    } else {
        format!(
            "{} ({}) wants to close {} ({}), a card on {machine} it did not open.",
            by.0, by.1, card.0, card.1
        )
    }];
    if let Some(why) = why {
        lines.push(format!("It says: {why}"));
    } else if !itself {
        lines.push("It gave no reason.".to_string());
    }
    if let Some(timeline) = text(c.get("timeline"), BODY_MOST) {
        lines.push(format!("It has a timeline still in flight: {timeline}."));
    }
    lines.push(
        "Closing takes the card off the wall and ends its process. It deletes nothing — the \
         transcript stays and the session can be adopted back. The wall checks again at the \
         moment of closing."
            .to_string(),
    );
    Some(Question {
        header: cut(&format!("close on {machine}"), HEADER_MOST),
        body: cut(&lines.join("\n\n"), BODY_MOST),
        options: vec![
            Choice { label: CLOSE_IT.to_string(), detail: "It comes off the wall. The transcript is kept.".to_string() },
            Choice { label: LEAVE_IT.to_string(), detail: "It stays. The agent is told you said so.".to_string() },
        ],
        shows: false,
    })
}

fn confirm_question(raw: Option<&Value>) -> Option<Question> {
    let c = raw?.as_object()?;
    let machine = text(c.get("machine"), 80)?;
    let act = text(c.get("act"), 200)?;
    let facts = c.get("facts").and_then(Value::as_array)?;
    if facts.is_empty() {
        return None;
    }
    let mut lines = vec![format!("A card on {machine} wants to {act}.")];
    for f in facts.iter().take(16) {
        let Some(f) = f.as_object() else { continue };
        let label = text(f.get("label"), 120).unwrap_or_default();
        let value = text(f.get("value"), 1_000).unwrap_or_default();
        if !label.is_empty() && !value.is_empty() {
            lines.push(format!("{label}: {value}"));
        }
    }
    if let Some(why) = text(c.get("why"), BODY_MOST) {
        lines.push(format!("Its reason: {why}"));
    }
    if let Some(stakes) = text(c.get("stakes"), BODY_MOST) {
        lines.push(stakes);
    }
    lines.push(
        "Nothing happens on this phone. If you say yes, the wall does it there and checks again \
         at that moment."
            .to_string(),
    );
    let mut options = Vec::new();
    for o in arr(c.get("options")).take(OPTIONS_MOST) {
        let Some(label) = text(o.get("label"), LABEL_MOST) else { continue };
        options.push(Choice { label, detail: text(o.get("detail"), DETAIL_MOST).unwrap_or_default() });
    }
    if options.len() < 2 {
        return None;
    }
    Some(Question {
        header: cut(&format!("{act} on {machine}"), HEADER_MOST),
        body: cut(&lines.join("\n\n"), BODY_MOST),
        options,
        shows: false,
    })
}

fn notice_fallback(kind: &str) -> &'static str {
    match kind {
        "done" => "It finished.",
        "question" => "It stopped on a question.",
        "error" => "It hit an error.",
        _ => "It has something for you.",
    }
}

fn named(raw: Option<&Value>) -> Option<(String, String)> {
    let o = raw?.as_object()?;
    let title = text(o.get("title"), HEADER_MOST)?;
    let handle = text(o.get("handle"), 80)?;
    Some((title, handle))
}

fn names(raw: Option<&Value>) -> String {
    arr(raw).take(6).filter_map(|v| text(Some(v), 120)).collect::<Vec<_>>().join(", ")
}

/* ── the reply a pick composes ─────────────────────────────────────────── */

/// The reply a set of picks composes, in the exact shape the agent reads.
///
/// One question is the bare answer and nothing else, because that is what every
/// ask before the multi-question form sent. Several are a numbered list carrying
/// each question's header, so the model cannot mis-pair an answer with the
/// decision it belongs to. An unanswered slot is `skipped`, never omitted — a
/// gap in a numbered list invites the model to re-align the rest.
///
/// `asking.ts::composeAnswer` is the desktop's, and this is the phone's: the
/// shape is the wire contract, not a rendering choice, so it must not drift.
pub fn compose(questions: &[Question], picks: &[String]) -> String {
    let slots: Vec<String> = questions
        .iter()
        .enumerate()
        .map(|(i, _)| picks.get(i).map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).unwrap_or_else(|| SKIPPED.to_string()))
        .collect();
    let said = if questions.len() == 1 {
        slots.first().cloned().unwrap_or_default()
    } else {
        let mut out = String::from(PREAMBLE);
        for (i, q) in questions.iter().enumerate() {
            out.push_str(&format!("\n{}. {}: {}", i + 1, q.header, slots[i]));
        }
        out
    };
    /* A skip is not permission, and the word alone leaves the model to infer
       what to do with it. Said once, however many slots carry it, under the
       marker the transcript's fold takes off again. */
    if slots.iter().any(|s| s == SKIPPED) {
        format!("{said}{ASIDE}{SKIPPED_ASIDE}")
    } else {
        said
    }
}

/* ── what was said before it ───────────────────────────────────────────── */

/// One line of a conversation, as a phone reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Said {
    /// `true` for a prompt a person opened, `false` for the agent.
    pub you: bool,
    pub text: String,
}

/// How many prose lines a context reading keeps, and how much text. Enough for
/// the paragraph that led to a question, never a transcript.
pub const SAID_MOST: usize = 12;
const SAID_TEXT_MOST: usize = 2_400;

/// The prose that led to a prompt, newest last.
///
/// A card's conversation is `conversation.svelte.ts`'s `Line[]`: `you` is a
/// prompt a person opened and `text` is the agent speaking, and everything else
/// is machinery — tool calls, tool results, compaction summaries, skills,
/// system notes. The question is *what led to this*, so only those two kinds
/// cross, and a tool call's arguments and output never do.
///
/// The budget is spent from the newest line backwards, as `tail.rs` does, so an
/// enormous summary at the start cannot cost the paragraph that prompted the
/// question. `narration: true` marks a line the app itself wrote (a turn
/// opened, a job started), which is not either party speaking.
pub fn said_before(lines: &Value, most: usize) -> Vec<Said> {
    let Some(all) = lines.as_array() else { return Vec::new() };
    let mut out: Vec<Said> = Vec::new();
    let mut spent = 0usize;
    for line in all.iter().rev() {
        if out.len() >= most {
            break;
        }
        let Some(o) = line.as_object() else { continue };
        if o.get("narration").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let you = match o.get("kind").and_then(Value::as_str) {
            Some("you") => true,
            Some("text") => false,
            _ => continue,
        };
        let Some(text) = text(o.get("text"), SAID_TEXT_MOST) else { continue };
        let text = text.trim().to_string();
        if text.is_empty() {
            continue;
        }
        if spent + text.chars().count() > SAID_TEXT_MOST && !out.is_empty() {
            break;
        }
        spent += text.chars().count();
        out.push(Said { you, text });
    }
    out.reverse();
    out
}

/* ── small readers ─────────────────────────────────────────────────────── */

fn arr(raw: Option<&Value>) -> impl Iterator<Item = &Value> {
    raw.and_then(Value::as_array).map(|a| a.as_slice()).unwrap_or(&[]).iter()
}

/// A string field, scrubbed of what an agent could not send and cut to `most`.
/// Empty after trimming is absent: a field that says nothing is not a field.
fn text(raw: Option<&Value>, most: usize) -> Option<String> {
    let s = raw?.as_str()?;
    let cut = cut(s, most);
    if cut.trim().is_empty() {
        None
    } else {
        Some(cut)
    }
}

/// Scrubbed and cut to `most` characters with a mark, never through a
/// surrogate pair. A preview's cap (`clip::preview`): what is on the wall is
/// whole and a glance away, so nothing failed to arrive.
fn cut(s: &str, most: usize) -> String {
    let clean = clean::scrub(s);
    let trimmed = clean.trim();
    if trimmed.chars().count() <= most {
        return trimmed.to_string();
    }
    let mut out: String = trimmed.chars().take(most.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// Bytes in `remove::human_size`'s register: two figures past a kilobyte,
/// since the decision is *is this the five-gigabyte one*.
fn human_size(bytes: u64) -> String {
    let units = ["B", "KB", "MB", "GB", "TB"];
    let mut n = bytes as f64;
    let mut u = 0;
    while n >= 1024.0 && u < units.len() - 1 {
        n /= 1024.0;
        u += 1;
    }
    if u == 0 {
        format!("{bytes} B")
    } else if n >= 100.0 {
        format!("{n:.0} {}", units[u])
    } else {
        format!("{n:.1} {}", units[u])
    }
}

fn waited(at: Option<i64>, since: Option<i64>, age_ms: u64) -> u64 {
    match (at, since) {
        (Some(at), Some(since)) => (at.saturating_sub(since).max(0) as u64).saturating_add(age_ms),
        _ => age_ms,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn snapshot(cards: Value) -> Value {
        json!({ "v": 1, "at": 10_000, "cards": cards })
    }

    fn card(id: &str, fields: Value) -> Value {
        let mut c = json!({ "id": id, "title": "caravan" });
        for (k, v) in fields.as_object().unwrap() {
            c[k] = v.clone();
        }
        c
    }

    #[test]
    fn a_parked_question_arrives_with_its_words_options_and_id() {
        let s = snapshot(json!([card(
            "c1",
            json!({ "asks": [{
                "askId": "ask-1",
                "since": 4_000,
                "questions": [
                    { "header": "which", "question": "square or circle?", "options": [
                        { "label": "square", "detail": "the honest one" },
                        { "label": "circle", "detail": null },
                    ], "shows": false },
                ],
            }] })
        )]));
        let p = read(&s, 1_500);
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].kind, Kind::Ask);
        assert_eq!(p[0].answers, "ask-1");
        assert_eq!(p[0].card, "c1");
        assert_eq!(p[0].title, "caravan");
        assert_eq!(p[0].waited_ms, 7_500, "owner-clock difference plus the snapshot's own age");
        assert_eq!(p[0].headline(), "which");
        assert_eq!(p[0].questions[0].body, "square or circle?");
        assert_eq!(p[0].questions[0].options.len(), 2);
        assert_eq!(p[0].questions[0].options[1].detail, "");
        assert!(p[0].pickable());
    }

    #[test]
    fn a_filed_question_is_answered_by_its_pile_row() {
        let s = snapshot(json!([card(
            "c1",
            json!({ "filed": [{ "askId": "row-9", "since": 0, "questions": [
                { "header": "", "question": "carry on?", "options": [] },
            ] }] })
        )]));
        let p = read(&s, 0);
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].kind, Kind::Filed);
        assert_eq!(p[0].answers, "deferred:row-9");
        assert!(!p[0].pickable(), "a filed question with no options is answered by speaking");
    }

    #[test]
    fn a_removal_says_the_machine_the_size_and_the_two_labels() {
        let s = snapshot(json!([card(
            "c1",
            json!({ "removals": [{ "askId": "a-r", "since": 0, "removal": {
                "machine": "desk", "reason": "the build directory is stale",
                "targets": [{
                    "path": "C:/p/build", "kind": "directory", "exists": true,
                    "entries": 40, "bytes": 5_242_880, "capped": false,
                    "own": false, "repo": false, "tracked": 0,
                    "writers": ["c2"], "servers": [],
                }],
            } }] })
        )]));
        let p = read(&s, 0);
        assert_eq!(p[0].kind, Kind::Removal);
        assert_eq!(p[0].answers, "a-r");
        let q = &p[0].questions[0];
        assert_eq!(q.header, "delete on desk");
        assert!(q.body.contains("C:/p/build"), "{}", q.body);
        assert!(q.body.contains("5.0 MB in 40 files"), "{}", q.body);
        assert!(q.body.contains("outside the card's own working tree"));
        assert!(q.body.contains("c2"));
        assert!(q.body.contains("permanent"));
        assert_eq!(q.options.iter().map(|o| o.label.as_str()).collect::<Vec<_>>(), vec![DELETE_IT, KEEP_IT]);
    }

    #[test]
    fn a_close_names_both_cards_and_the_timeline() {
        let s = snapshot(json!([card(
            "c1",
            json!({ "closings": [{ "askId": "a-c", "since": 0, "closing": {
                "machine": "desk",
                "card": { "title": "orchard", "handle": "o1" },
                "by": { "title": "caravan", "handle": "c1" },
                "why": null,
                "timeline": "the migration, step 3 of 8",
            } }] })
        )]));
        let p = read(&s, 0);
        assert_eq!(p[0].kind, Kind::Close);
        let q = &p[0].questions[0];
        assert_eq!(q.header, "close on desk");
        assert!(q.body.contains("caravan"));
        assert!(q.body.contains("orchard"));
        assert!(q.body.contains("gave no reason"), "{}", q.body);
        assert!(q.body.contains("step 3 of 8"));
        assert_eq!(q.options.iter().map(|o| o.label.as_str()).collect::<Vec<_>>(), vec![CLOSE_IT, LEAVE_IT]);
    }

    #[test]
    fn a_confirmation_carries_its_facts_and_its_own_labels() {
        let s = snapshot(json!([card(
            "c1",
            json!({ "confirms": [{ "askId": "a-p", "since": 0, "confirm": {
                "machine": "desk", "act": "open a pull request",
                "facts": [
                    { "label": "repository", "value": "team/repo" },
                    { "label": "from", "value": "fix to main" },
                ],
                "why": "the fix is proven", "stakes": "it is public",
                "options": [
                    { "label": "open it", "detail": null },
                    { "label": "not now", "detail": "keep the branch" },
                ],
            } }] })
        )]));
        let p = read(&s, 0);
        assert_eq!(p[0].kind, Kind::Confirm);
        let q = &p[0].questions[0];
        assert_eq!(q.header, "open a pull request on desk");
        assert!(q.body.contains("team/repo"));
        assert!(q.body.contains("the fix is proven"));
        assert!(q.body.contains("it is public"));
        assert_eq!(q.options[0].label, "open it");
        assert_eq!(q.options[1].detail, "keep the branch");
    }

    #[test]
    fn a_notice_without_a_turn_names_the_acknowledgement_prefix() {
        let s = snapshot(json!([card(
            "c1",
            json!({ "notices": [{ "id": "n1", "kind": "done", "text": "all green", "raisedAt": 9_000, "askId": null }] })
        )]));
        let p = read(&s, 0);
        assert_eq!(p[0].kind, Kind::Notice);
        assert_eq!(p[0].answers, "notice:n1");
        assert_eq!(p[0].questions[0].body, "all green");
        assert!(!p[0].pickable());
        assert_eq!(p[0].ack.as_deref(), Some(ACKNOWLEDGED), "a notice with no turn is taken down by the ack word");
    }

    #[test]
    fn a_notice_holding_a_turn_is_answered_by_its_ask() {
        let s = snapshot(json!([card(
            "c1",
            json!({ "notices": [{ "id": "n1", "kind": "question", "text": "", "raisedAt": 0, "askId": "ask-7" }] })
        )]));
        let p = read(&s, 0);
        assert_eq!(p[0].answers, "ask-7");
        assert_eq!(p[0].questions[0].body, "It stopped on a question.");
        assert!(p[0].ack.is_none(), "a notice holding a turn is answered, not acknowledged");
    }

    #[test]
    fn blocking_outranks_notices_and_the_oldest_blocking_comes_first() {
        let s = snapshot(json!([
            card("c1", json!({ "notices": [{ "id": "n1", "kind": "done", "text": "done", "raisedAt": 9_000 }] })),
            card("c2", json!({ "asks": [{ "askId": "new", "since": 9_000, "questions": [{ "question": "later" }] }] })),
            card("c3", json!({ "removals": [{ "askId": "old", "since": 1_000, "removal": {
                "machine": "desk", "reason": "r", "targets": [{ "path": "p", "kind": "file", "exists": true, "entries": 1, "bytes": 1, "capped": false, "own": true, "repo": false }],
            } }] })),
        ]));
        let p = read(&s, 0);
        let kinds: Vec<Kind> = p.iter().map(|p| p.kind).collect();
        assert_eq!(kinds, vec![Kind::Removal, Kind::Ask, Kind::Notice], "oldest blocking first, notices last");
        assert_eq!(p[0].answers, "old");
    }

    /// The pile is an inbox, not a queue: its newest row is the one still worth
    /// reading, and an eight-day-old one must not sit above a live question.
    #[test]
    fn a_live_question_outranks_the_pile_and_the_piles_newest_comes_first() {
        let s = snapshot(json!([
            card("c1", json!({ "filed": [
                { "askId": "old", "since": 0, "questions": [{ "question": "from last week" }] },
                { "askId": "new", "since": 9_000, "questions": [{ "question": "from this morning" }] },
            ] })),
            card("c2", json!({ "asks": [{ "askId": "live", "since": 9_500, "questions": [{ "question": "now" }] }] })),
        ]));
        let p = read(&s, 0);
        assert_eq!(p[0].answers, "live", "a question somebody is stopped on comes first");
        assert_eq!(p[1].answers, "deferred:new", "then the pile, newest first");
        assert_eq!(p[2].answers, "deferred:old");
    }

    #[test]
    fn a_card_with_no_id_or_an_ask_with_no_id_is_dropped() {
        let s = snapshot(json!([
            json!({ "title": "nameless", "asks": [{ "askId": "a", "questions": [{ "question": "q" }] }] }),
            card("c1", json!({ "asks": [{ "since": 0, "questions": [{ "question": "no id" }] }] })),
        ]));
        assert!(read(&s, 0).is_empty());
    }

    /// An ask whose words did not survive into the digest is still an ask. The
    /// card is stopped and the roster counts it; dropping it left a row saying
    /// "1 question waiting" with nothing anywhere to answer.
    #[test]
    fn a_wordless_ask_is_drawn_as_a_question_that_can_be_answered() {
        let s = snapshot(json!([card("c1", json!({ "asks": [{ "askId": "ask-1", "since": 0, "questions": [] }] }))]));
        let p = read(&s, 0);
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].kind, Kind::Ask);
        assert_eq!(p[0].answers, "ask-1");
        assert!(!p[0].pickable());
        assert!(p[0].questions[0].body.contains("did not reach this phone"), "{}", p[0].questions[0].body);
    }

    /// A question with options and no words is a real choice: the labels are
    /// the question, so it is kept rather than dropped.
    #[test]
    fn a_question_with_only_options_is_kept() {
        let s = snapshot(json!([card(
            "c1",
            json!({ "asks": [{ "askId": "a", "questions": [{ "options": [{ "label": "yes" }, { "label": "no" }] }] }] })
        )]));
        let p = read(&s, 0);
        assert_eq!(p.len(), 1);
        assert!(p[0].pickable());
        assert_eq!(p[0].questions[0].options.len(), 2);
    }

    #[test]
    fn a_hostile_length_is_cut_with_a_mark_and_surrogate_pairs_survive() {
        let long = "😀".repeat(3_000);
        let s = snapshot(json!([card(
            "c1",
            json!({ "asks": [{ "askId": "a", "questions": [{ "header": "h", "question": long }] }] })
        )]));
        let p = read(&s, 0);
        let body = &p[0].questions[0].body;
        assert_eq!(body.chars().count(), BODY_MOST);
        assert!(body.ends_with('…'));
        assert!(body.chars().all(|c| c == '😀' || c == '…'), "never cut inside a pair");
    }

    #[test]
    fn a_question_that_says_it_has_a_design_says_so() {
        let s = snapshot(json!([card(
            "c1",
            json!({ "asks": [{ "askId": "a", "questions": [{ "question": "this one?", "options": [{ "label": "yes", "detail": "d" }], "shows": true }] }] })
        )]));
        let p = read(&s, 0);
        assert!(p[0].questions[0].shows);
    }

    #[test]
    fn one_answer_is_bare_and_several_are_numbered() {
        let one = vec![Question { header: "which".into(), body: "?".into(), options: vec![], shows: false }];
        assert_eq!(compose(&one, &["square".into()]), "square");
        let two = vec![
            Question { header: "which".into(), body: "?".into(), options: vec![], shows: false },
            Question { header: "how many".into(), body: "?".into(), options: vec![], shows: false },
        ];
        assert_eq!(
            compose(&two, &["square".into(), "three".into()]),
            "Answering each in turn:\n1. which: square\n2. how many: three"
        );
        let skipped = compose(&two, &["square".into(), "".into()]);
        assert!(
            skipped.starts_with("Answering each in turn:\n1. which: square\n2. how many: skipped"),
            "{skipped}"
        );
        assert!(skipped.contains("a skip is not permission"), "{skipped}");
        assert!(skipped.contains("— skein: "), "the aside rides the marker answerNote strips");
    }

    fn tail() -> Value {
        json!([
            { "kind": "you", "text": "look at the failing test" },
            { "kind": "tool", "text": "", "call": { "name": "Bash", "input": "{\"command\":\"bun test\"}" } },
            { "kind": "text", "text": "The failure is in the parser." },
            { "kind": "meta", "text": "a note" },
            { "kind": "text", "text": "", "narration": true },
            { "kind": "text", "text": "Should I widen it to all three cases?" },
        ])
    }

    #[test]
    fn only_the_prose_before_a_question_crosses_and_the_tool_calls_do_not() {
        let said = said_before(&tail(), SAID_MOST);
        assert_eq!(said.len(), 3, "{said:?}");
        assert!(said[0].you);
        assert_eq!(said[0].text, "look at the failing test");
        assert!(!said[1].you);
        assert_eq!(said[1].text, "The failure is in the parser.");
        assert_eq!(said[2].text, "Should I widen it to all three cases?");
        assert!(said.iter().all(|s| !s.text.contains("bun test")), "a tool call's arguments never cross");
    }

    #[test]
    fn the_context_keeps_the_newest_lines_and_is_bounded() {
        let many: Vec<Value> = (0..40).map(|i| json!({ "kind": "text", "text": format!("line {i}") })).collect();
        let said = said_before(&Value::Array(many), SAID_MOST);
        assert_eq!(said.len(), SAID_MOST);
        assert_eq!(said.last().unwrap().text, "line 39");
    }

    #[test]
    fn a_snapshot_with_no_cards_is_no_prompts() {
        assert!(read(&json!({ "v": 1 }), 0).is_empty());
        assert!(said_before(&json!({}), 10).is_empty());
    }
}
