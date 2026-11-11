//! What a prompt *is*, as a form and a kind.
//!
//! `docs/ANALYTICS.md` §3.8 keeps seven words of vocabulary (`design`,
//! `redirect`, `nudge`, `task`, `question`, `issue`, `other`) and a handful of
//! numbers. Both are decided **here, in Rust, on the raw text**, because the
//! ingestor is the only thing that ever sees a prompt: the body is redacted and
//! dropped in this lane and sealed behind a vault in the next, so a classifier
//! reading it afterwards could not exist.
//!
//! Three things about the arrangement are the design:
//!
//! - **Deterministic, not clever.** The same text gets the same kind for ever,
//!   because a rate over months is only readable if the answer did not drift.
//!   No model, no clock, no randomness, and the rules are an ordered list of
//!   tests read top to bottom.
//! - **The form is measured before redaction.** Taking a key out of a sentence
//!   changes its characters, and the shape being read is the shape that was
//!   typed. The ingestor computes this from the fold's text, then hands the same
//!   text to `redact` and drops it.
//! - **Nothing here stores or logs a word.** A kind, seven counts and five
//!   buckets are the whole of what leaves. `test/prompt.test.ts` holds the
//!   vocabulary to the TypeScript the trace will draw, which is display only.
//!
//! The classifier is pure and dependency-free on purpose: `tools/lift-prompt.ts`
//! runs its tests on a machine that cannot link the crate, which is the only way
//! these rules are ever executed here (`.claude/rules/build.md`).

use crate::redact::fence_blocks;

/// The seven kinds, in the order §3.8 lists them.
///
/// This array is the vocabulary. `test/prompt.test.ts` reads it out of this file
/// and fails if the TypeScript the trace draws has drifted from it, which is the
/// same guard `test/afar.test.ts` keeps on `remove.rs`.
pub const KINDS: [&str; 7] = [
    "design", "redirect", "nudge", "task", "question", "issue", "other",
];

/// What a prompt was for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// A brief: scope, trade-offs, several paragraphs and often a list.
    Design,
    /// A correction that turns the work: "no, the other one".
    Redirect,
    /// One word of encouragement with no object in it: "continue".
    Nudge,
    /// An instruction with a thing in it: "add a redact module".
    Task,
    /// A question, including one that asks for work ("can you fix this?" is a
    /// request wearing a question mark, and is a `Task`).
    Question,
    /// Something is broken: a failure, an error, a regression.
    Issue,
    /// None of the above, which is a real answer rather than a failure.
    Other,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Design => "design",
            Kind::Redirect => "redirect",
            Kind::Nudge => "nudge",
            Kind::Task => "task",
            Kind::Question => "question",
            Kind::Issue => "issue",
            Kind::Other => "other",
        }
    }
}

/// A prompt's shape, counted and never kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Form {
    pub chars: usize,
    pub words: usize,
    pub lines: usize,
    pub fences: usize,
    pub code_lines: usize,
    pub images: usize,
    pub questions: usize,
}

/// Which of `prompt_hour`'s five word bands a length falls in: `0-15`, `16-63`,
/// `64-255`, `256-1023`, `1024+`.
///
/// The bands are exclusive and exhaustive so they sum to the prompt count, which
/// is what lets a year of prompts answer a median-shaped question when a sum
/// cannot. A band added without its neighbour subtracted would double count, so
/// `the_bands_partition_every_length` walks the boundaries.
pub fn word_band(words: usize) -> usize {
    match words {
        0..=15 => 0,
        16..=63 => 1,
        64..=255 => 2,
        256..=1023 => 3,
        _ => 4,
    }
}

/// The form of `text`, with the image blocks the record carried.
pub fn form(text: &str, images: usize) -> Form {
    let fences = fence_blocks(text);
    Form {
        chars: text.chars().count(),
        words: text.split_whitespace().count(),
        /* A trailing newline does not make a line: the count is of what was
           written, which is what `lines()` answers. */
        lines: if text.is_empty() { 0 } else { text.lines().count() },
        fences: fences.len(),
        code_lines: fences.iter().map(|f| f.lines).sum(),
        images,
        questions: text.matches('?').count(),
    }
}

/// What this prompt was for.
///
/// The rules are tried in this order, and the order is the classifier's whole
/// argument: the narrow shapes first, the long one next, then what is being
/// asked, and an imperative last. A rule that fired for everything would make
/// the four below it dead code, so each one is written as narrowly as the corpus
/// allows and the tests below name a prompt for every arm.
pub fn kind(text: &str) -> Kind {
    let words = words(text);
    if words.is_empty() {
        return Kind::Other;
    }
    if is_nudge(&words) {
        return Kind::Nudge;
    }
    if is_redirect(&words) {
        return Kind::Redirect;
    }
    if is_design(text, &words) {
        return Kind::Design;
    }
    if is_request(&words) {
        return Kind::Task;
    }
    if is_question(text, &words) {
        return Kind::Question;
    }
    if is_issue(&words) {
        return Kind::Issue;
    }
    if is_task(&words) {
        return Kind::Task;
    }
    Kind::Other
}

/* ── the rules, each of them narrow on purpose ───────────────────────────── */

/// A prompt whose whole content is "go on".
///
/// The test is the *absence of an object*, so it is an exact match against a
/// small vocabulary rather than a search for a verb. "continue" alone is a
/// nudge; "continue by rewriting the header" is a task, and it is the second
/// word that says so.
fn is_nudge(words: &[String]) -> bool {
    const NUDGES: [&str; 20] = [
        "continue", "go on", "carry on", "keep going", "keep working", "proceed", "resume",
        "go ahead", "go", "next", "more", "again", "try again", "retry", "same again", "yes",
        "yep", "ok", "okay", "do it",
    ];
    /* Politeness and timing are not a request: "continue please" is still a
       nudge, and so is "go on then". */
    let mut tail = words;
    while let Some(last) = tail.last() {
        if matches!(last.as_str(), "please" | "thanks" | "now" | "then") {
            tail = &tail[..tail.len() - 1];
        } else {
            break;
        }
    }
    let said = tail.join(" ");
    if said.is_empty() {
        return false;
    }
    NUDGES.contains(&said.as_str()) || said == "continue from where you left off"
}

/// A correction, spoken at the front. The cues are openers because a redirect
/// *starts* by stopping something; the same word in the middle of a paragraph is
/// usually a design brief's trade-off.
fn is_redirect(words: &[String]) -> bool {
    const OPENERS: [&str; 26] = [
        "no", "nope", "stop", "wait", "hold on", "actually", "instead", "don't", "dont",
        "do not", "not that", "wrong", "undo", "revert", "scratch that", "forget that",
        "change of plan", "let's not", "lets not", "on second thought", "back up", "almost",
        "not quite", "rather", "hang on", "that's wrong",
    ];
    let head = words.iter().take(3).cloned().collect::<Vec<_>>().join(" ");
    OPENERS.iter().any(|o| head == *o || head.starts_with(&format!("{o} ")))
        /* "instead" mid-sentence is still a redirect, and it is the one cue
           whose position does not matter: it names the correction itself. */
        || (words.len() <= 80 && words.iter().any(|w| w == "instead"))
}

/// A brief. Length is the signal, and it is chosen over vocabulary because a
/// long prompt is a long prompt whatever words it uses: 120 words of anything is
/// somebody describing a shape rather than asking for one change.
///
/// The second arm catches the shorter brief, which is recognisable by its
/// furniture: a heading, three or more bullets, or a fence it wants drawn.
fn is_design(text: &str, words: &[String]) -> bool {
    if words.len() >= 120 {
        return true;
    }
    if words.len() >= 60 {
        let bullets = text
            .lines()
            .filter(|l| {
                let t = l.trim_start();
                t.starts_with("- ") || t.starts_with("* ") || t.starts_with("+ ")
                    || t.split_once('.').is_some_and(|(n, _)| {
                        !n.is_empty() && n.len() <= 2 && n.bytes().all(|c| c.is_ascii_digit())
                    })
            })
            .count();
        let heading = text.lines().any(|l| l.trim_start().starts_with('#'));
        if bullets >= 3 || heading {
            return true;
        }
    }
    false
}

/// A request wearing a question mark: "can you fix the build?" asks for work, so
/// it is a task and not a question. This is the one place the two rules overlap
/// and the reason a bare trailing `?` is not enough on its own.
fn is_request(words: &[String]) -> bool {
    let pair = words.iter().take(2).cloned().collect::<Vec<_>>().join(" ");
    matches!(
        pair.as_str(),
        "can you" | "could you" | "would you" | "will you" | "can we" | "could we" | "would we"
    )
}

/// Ends in a question mark, or opens with the word that makes it one.
///
/// The mark is tested after trailing quotes and brackets, because a quoted
/// question ends `?"` often enough to matter.
fn is_question(text: &str, words: &[String]) -> bool {
    let opened = ["how", "why", "what", "where", "when", "which", "who", "whose", "is", "are",
        "was", "were", "do", "does", "did", "should", "shall", "may", "might", "has", "have"];
    if words.first().is_some_and(|w| opened.contains(&w.as_str())) {
        return true;
    }
    let t = text.trim_end();
    let t = t.trim_end_matches(['"', '\'', ')', ']', '}', '`']);
    t.ends_with('?')
}

/// Something is broken.
fn is_issue(words: &[String]) -> bool {
    const CUES: [&str; 24] = [
        "bug", "bugs", "buggy", "broken", "breaks", "crash", "crashes", "crashing", "error",
        "errors", "exception", "fails", "failing", "failed", "failure", "regression", "panic",
        "panics", "traceback", "leak", "leaks", "leaking", "timeout", "nan",
    ];
    words.iter().any(|w| CUES.contains(&w.as_str()))
        || has(words, &["does", "not", "work"])
        || has(words, &["doesn't", "work"])
        || has(words, &["doesnt", "work"])
        || has(words, &["not", "working"])
        || has(words, &["isn't", "working"])
        || has(words, &["won't", "work"])
        || has(words, &["stack", "trace"])
}

/// An instruction, and the cues are the imperative verb it opens with. A list is
/// accepted too, because three bullets are three instructions however they were
/// punctuated.
fn is_task(words: &[String]) -> bool {
    /* `continue`, `keep` and `go` are here as well as in the nudge vocabulary,
       and the order of the arms is what keeps them apart: one of those words
       *alone* is a nudge, and followed by an object it is an instruction. */
    const VERBS: [&str; 46] = [
        "add", "build", "create", "implement", "fix", "make", "write", "update", "change",
        "remove", "delete", "rename", "move", "refactor", "extract", "split", "merge", "port",
        "wire", "hook", "tidy", "clean", "document", "review", "check", "run", "test", "revert",
        "replace", "drop", "bump", "ship", "cut", "sketch", "draw", "set", "put", "use", "keep",
        "start", "stop", "open", "close", "read", "continue", "go",
    ];
    const LEADS: [&str; 6] = ["please", "let's", "lets", "i need you to", "i want you to", "i'd like"];
    let first = words[0].as_str();
    if VERBS.contains(&first) || LEADS.iter().any(|l| words.iter().take(4).cloned().collect::<Vec<_>>().join(" ").starts_with(l)) {
        return true;
    }
    /* A list of things wanted is a task even when no verb opens it, provided
       there are enough of them to be a list rather than a sentence. */
    counts_as_list(words)
}

/// Three bullets' worth of items, counted from the words rather than the lines,
/// because `is_task` is handed only the words. A sentence of two commas is not a
/// list; three short items separated by commas usually are.
fn counts_as_list(words: &[String]) -> bool {
    words.len() <= 60 && words.iter().filter(|w| *w == "and").count() >= 2
}

/// Is `phrase` in `words`, in order?
fn has(words: &[String], phrase: &[&str]) -> bool {
    words.len() >= phrase.len()
        && words
            .windows(phrase.len())
            .any(|w| w.iter().zip(phrase).all(|(a, b)| a == b))
}

/// The text as lower-case words with their punctuation edges taken off, which is
/// what every rule above matches on. An apostrophe, a hyphen, a slash and an
/// underscore stay inside a word, because `doesn't`, `api_key` and `won't` are
/// words and `won` is not.
fn words(text: &str) -> Vec<String> {
    text.split_whitespace()
        .map(|w| {
            w.trim_matches(|c: char| {
                !(c.is_alphanumeric() || matches!(c, '\'' | '-' | '_' | '/' | '#'))
            })
            .to_lowercase()
        })
        .filter(|w| !w.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One prompt per arm, and each is written to be caught by that arm and not
    /// the one before it. A vocabulary with no prompt behind a kind is a kind
    /// nothing has ever been sorted into.
    #[test]
    fn every_kind_has_a_prompt_that_lands_in_it() {
        let cases: [(&str, Kind); 7] = [
            (
                "Continue.",
                Kind::Nudge,
            ),
            (
                "no, put the toggle on the left rail instead",
                Kind::Redirect,
            ),
            (
                "add a redact module beside the ingest and wire it into the ledger",
                Kind::Task,
            ),
            (
                "why does the transcript say command-name on those lines?",
                Kind::Question,
            ),
            (
                "the analytics panel is broken: it crashes when a saved view is deleted",
                Kind::Issue,
            ),
            (
                "Consider how the room should read. The chart and the table share a column, and \
                 the inspector sits beside them at the width the panel already uses. Weigh a \
                 single scroll against three panes, say which you would pick and why, and keep \
                 the keyboard path for everything. Add the heading, the filter row and the table \
                 view. Say what the saved view format has to carry for a widget to reopen it, \
                 and what a deleted view should leave behind. Write the answer down before you \
                 build anything, because the arguments are what this phase is for and the pixels \
                 come later. Then sketch the layout at two densities and say what changes \
                 between them. Keep the copy lowercase and quiet, the way the rest of the wall \
                 reads, and leave the hall for a later phase entirely.",
                Kind::Design,
            ),
            (
                "hmm",
                Kind::Other,
            ),
        ];
        for (text, want) in cases {
            assert_eq!(kind(text), want, "wrong kind for {text:?}");
        }
    }

    /// The two arms that overlap most, in both directions: a question that asks
    /// for work is a task, and a task that happens to end in a question mark is
    /// still a question when it opens with an interrogative.
    #[test]
    fn a_request_wearing_a_question_mark_is_a_task() {
        assert_eq!(kind("can you fix the build?"), Kind::Task);
        assert_eq!(kind("could you add a field to the panel"), Kind::Task);
        assert_eq!(kind("is the panel drawing the wrong axis?"), Kind::Question);
    }

    /// A nudge is the absence of an object, and one word of object takes it back
    /// out of the nudge arm.
    #[test]
    fn a_nudge_with_a_thing_in_it_is_not_a_nudge() {
        assert_eq!(kind("continue"), Kind::Nudge);
        assert_eq!(kind("continue please"), Kind::Nudge);
        assert_eq!(kind("Continue from where you left off."), Kind::Nudge);
        assert_eq!(kind("continue by rewriting the header to say the day"), Kind::Task);
    }

    /// A redirect *starts* by stopping something. The same word in the middle of
    /// a paragraph is a trade-off, not a correction.
    #[test]
    fn a_redirect_is_an_opener_and_not_a_word_in_the_middle() {
        assert_eq!(kind("wait, use the other column"), Kind::Redirect);
        assert_eq!(kind("actually no"), Kind::Redirect);
        assert_eq!(kind("use the left rail instead"), Kind::Redirect);
    }

    /// The form is counted before redaction and keeps what a title would lose.
    #[test]
    fn the_form_counts_lines_and_fences() {
        let text = "draw a box:\n```rust\nfn main() {}\nfn b() {}\n```\ndone?";
        let f = form(text, 2);
        assert_eq!(f.lines, 6);
        assert_eq!(f.fences, 1);
        assert_eq!(f.code_lines, 2);
        assert_eq!(f.questions, 1);
        assert_eq!(f.images, 2);
        assert_eq!(f.words, 12, "the fence markers are words like any other");
        assert_eq!(f.chars, text.chars().count());
    }

    /// An empty prompt has no lines and no words rather than one of each.
    #[test]
    fn nothing_said_has_no_shape() {
        assert_eq!(form("", 0), Form::default());
    }

    /// The five bands are exclusive and exhaustive, which is what makes them sum
    /// to the prompt count. Walking every boundary is the only way to catch a
    /// band added without its neighbour changed.
    #[test]
    fn the_bands_partition_every_length() {
        assert_eq!([word_band(0), word_band(15)], [0, 0]);
        assert_eq!([word_band(16), word_band(63)], [1, 1]);
        assert_eq!([word_band(64), word_band(255)], [2, 2]);
        assert_eq!([word_band(256), word_band(1023)], [3, 3]);
        assert_eq!([word_band(1024), word_band(1_000_000)], [4, 4]);
        let mut seen = [false; 5];
        for n in 0..2000 {
            let b = word_band(n);
            assert!(b < 5, "{n} fell outside every band");
            seen[b] = true;
        }
        assert!(seen.iter().all(|s| *s), "a band nothing landed in");
    }

    /// The vocabulary is the seven words §3.8 published, once each.
    #[test]
    fn the_vocabulary_is_seven_words() {
        assert_eq!(KINDS.len(), 7);
        for (i, k) in [Kind::Design, Kind::Redirect, Kind::Nudge, Kind::Task, Kind::Question, Kind::Issue, Kind::Other]
            .into_iter()
            .enumerate()
        {
            assert_eq!(k.as_str(), KINDS[i], "as_str and KINDS disagree at {i}");
        }
    }
}
