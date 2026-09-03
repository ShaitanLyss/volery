//! Cutting text to fit, and saying so.
//!
//! Every tool surface on this wall has a budget somewhere, and until 2026-09-03
//! each one enforced its own with its own `s.chars().take(max)`. Six copies, in
//! three different states of honesty — and the interesting thing is that the
//! three states were not a disagreement about design, they were the same lesson
//! learned three times and never carried across:
//!
//! - **`sink.rs`, `later.rs`, `guidance.rs`, `store.rs`** cut and said nothing.
//! - **`relay.rs`** cut and appended `[…truncated by skein at N characters]`,
//!   which tells you it happened and neither how much you lost nor what to do.
//! - **`board.rs`** told the *writer* how many characters were over, in the
//!   receipt, and left the *reader* looking at a body that ends mid-sentence.
//! - **`spawn.rs`'s `clip_brief`** got all of it right — a boundary, a count, a
//!   remedy — and had no live caller, because by then the argument for having a
//!   cap on a brief at all had not survived (`MAX_PROMPT`).
//!
//! So the good implementation was the one nobody ran. This module is that
//! implementation, lifted out and made to serve all of them, and the caps that
//! remain now all cut the same way.
//!
//! ## Why this class of bug is worse here than in most applications
//!
//! Sink `33031132` collected the sites and `7b26058e` measured the damage: at
//! the time of writing, sixteen open sink items sat *exactly* on the 1,200
//! character cap, every one of them ending mid-sentence — including one cut
//! mid-word inside the sentence explaining its own cause. The tails were gone
//! from the store, not merely from the listing.
//!
//! The reason it costs more here is that **on nearly every path through this
//! app, the reader is an agent**, and an agent cannot tell a clipped text from a
//! complete one. A person seeing a paragraph stop mid-word knows to go and look
//! for the rest. A model reads what it was given as the whole of what there is,
//! reasons from it confidently, and reports a conclusion drawn from half a
//! specification — which is exactly what happened to the card in `f468f017`,
//! and it only noticed because the cut landed mid-word. **A tidier cut would
//! have hidden it better.** That is the trap this module exists to answer, and
//! it is why the boundary rule and the marker are not alternatives: the boundary
//! rule exists so that the marker is the only thing that has to tell the truth.
//!
//! ## The two rules
//!
//! 1. **Cut at a boundary** — a paragraph, then a list item, then a word — but
//!    never so far back that finding one costs more than the mid-word cut it was
//!    improving on. That is `BOUNDARY_FLOOR`.
//! 2. **Mark it at both ends.** The text carries a marker for whoever reads it,
//!    naming the count and a *next move*; the receipt tells whoever wrote it, so
//!    a caller that still holds the whole thing knows to send the rest. Neither
//!    half is sufficient: a marker in the text reaches a reader who cannot fix
//!    it, and a count in a receipt reaches a writer who has already moved on.

/// How far back from the cap a boundary may be looked for, as a fraction of it.
///
/// A boundary rule with no floor is a rule that can throw away most of a text to
/// find a blank line: a five-thousand-character paragraph with one `\n\n` at
/// character 40 would clip to forty characters, which is worse than the mid-word
/// cut it was supposed to improve on. So each rule is tried in turn and taken
/// only if it lands in the last quarter of the budget; otherwise the next,
/// weaker one gets a go, and a text with no boundaries in it at all is cut where
/// it was always going to be cut.
pub const BOUNDARY_FLOOR: f64 = 0.75;

/// What a cut left, and what it cost.
///
/// `omitted == 0` is the ordinary case and means `kept` is the whole of what
/// arrived — callers should branch on [`Cut::happened`] rather than comparing
/// lengths, since the marker makes `kept` longer than the input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cut {
    /// The text as it should be stored or shown. Carries no marker — call
    /// [`Cut::marked`] for that.
    pub kept: String,
    /// Characters that did not survive. Zero when nothing was cut.
    pub omitted: usize,
    /// What arrived, in characters, so a receipt can name the whole size rather
    /// than only the overflow. `board.rs` reports `max + omitted` from its own
    /// arithmetic; this is that number without the sum.
    pub total: usize,
}

impl Cut {
    /// Did anything actually get thrown away?
    pub fn happened(&self) -> bool {
        self.omitted > 0
    }

    /// The kept text with a marker naming what was lost and what to do about it.
    ///
    /// `remedy` is a sentence for the reader — *"ask the card that opened you
    /// for the rest"*, *"the whole of it is on the item"*. It is per-site
    /// because the next move genuinely differs, and it is **required** rather
    /// than optional: a marker that names a loss and no way to make it good
    /// leaves an agent knowing it is missing something and unable to act, which
    /// is the state `relay.rs`'s old marker left every reader in.
    ///
    /// Returns the text unchanged when nothing was cut, so a caller may hand it
    /// through unconditionally.
    pub fn marked(&self, remedy: &str) -> String {
        if !self.happened() {
            return self.kept.clone();
        }
        format!(
            "{}\n\n[clipped by the wall — {} of {} characters did not arrive. What you have \
             above may read as complete and is not. {remedy}]",
            self.kept.trim_end(),
            self.omitted,
            self.total,
        )
    }
}

/// Cut `s` to at most `max` characters, at the strongest boundary that does not
/// cost more than it saves.
///
/// `max` is in **characters**, not bytes, and so is every number that comes
/// back. That is not a stylistic choice: the panel counts characters, the caps
/// are written as characters, and slicing a byte range through the middle of a
/// multi-byte character panics. Somebody's standing instructions are exactly
/// where an em dash or an accented name shows up (`guidance.rs` learned this
/// one first).
pub fn keep(s: &str, max: usize) -> Cut {
    let chars: Vec<char> = s.chars().collect();
    let total = chars.len();
    if total <= max {
        return Cut { kept: s.to_string(), omitted: 0, total };
    }

    let head: String = chars[..max].iter().collect();
    let floor = (max as f64 * BOUNDARY_FLOOR) as usize;

    /* Strongest first. A paragraph break is a whole thought; a line break is a
       list item, which is the shape the brief that found this bug was in; a
       space is merely not mid-word. `rfind` answers in bytes, and every needle
       here is ASCII, so the byte index is a char boundary — but the *count*
       that goes in the marker has to be in characters, since that is what `max`
       is measured in and what the caller will compare against. */
    let cut = ["\n\n", "\n", " "]
        .iter()
        .find_map(|sep| {
            let at = head.rfind(sep)?;
            let kept = head[..at].chars().count();
            (kept >= floor).then_some(kept)
        })
        .unwrap_or(max);

    let kept: String = chars[..cut].iter().collect();
    Cut { kept: kept.trim_end().to_string(), omitted: total - cut, total }
}

/// A short label for something whose whole text is somewhere the reader can
/// already see.
///
/// **This is not the same act as [`keep`] and must not wear its marker.** A
/// budget loses text: the tail is gone, the reader cannot get it back
/// unaided, and so it is owed a count and a next move. A *preview* loses
/// nothing — it is a strand label in the flow, a line in a log reading, a
/// question's first sentence — and the whole of it is on the wall a glance
/// away. Putting "N of M characters did not arrive, ask the card for the
/// rest" on a 240-character strand label would be false twice over: nothing
/// failed to arrive, and there is nobody to ask.
///
/// So the honest mark for a preview is an ellipsis, which is what every
/// reader already understands it to mean. `servers.rs`'s `clip_line` and
/// `smith.rs`'s question-shortener were both this shape before this module
/// existed, and both were right.
///
/// The test worth keeping in mind: **who reads it, and can they get the
/// rest?** If the answer is an agent who cannot, it is [`keep`].
pub fn preview(s: &str, max: usize) -> String {
    let cut = keep(s, max.saturating_sub(1));
    if !cut.happened() {
        return cut.kept;
    }
    format!("{}…", cut.kept)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A preview under the cap is the text itself, with nothing added — an
    /// ellipsis on a label that fits is a lie about there being more.
    #[test]
    fn a_short_preview_gains_nothing() {
        assert_eq!(preview("a short subject", 40), "a short subject");
    }

    /// Over the cap it ends in an ellipsis and stays within the cap, counting
    /// the ellipsis itself — the number is a width, and a label one character
    /// over its box is the bug the cap exists to prevent.
    #[test]
    fn a_long_preview_ends_in_an_ellipsis_and_fits() {
        let s = "w".repeat(60);
        let out = preview(&s, 40);
        assert!(out.ends_with('…'), "{out}");
        assert_eq!(out.chars().count(), 40);
    }

    /// And it carries none of `keep`'s marker, because nothing was lost that
    /// the reader cannot see for themselves.
    #[test]
    fn a_preview_does_not_claim_something_went_missing() {
        let out = preview(&"w".repeat(60), 40);
        assert!(!out.contains("clipped by the wall"), "{out}");
        assert!(!out.contains("did not arrive"), "{out}");
    }

    /// The ordinary case is the one worth pinning first: nothing under the cap
    /// may be touched, and `marked` must be a pass-through so a caller can hand
    /// text through it without asking whether it needs to.
    #[test]
    fn short_text_is_untouched() {
        let c = keep("a short note", 100);
        assert_eq!(c.kept, "a short note");
        assert_eq!(c.omitted, 0);
        assert_eq!(c.total, 12);
        assert!(!c.happened());
        assert_eq!(c.marked("ask for the rest"), "a short note");
    }

    /// Exactly on the cap is not over it. This boundary is worth its own test
    /// because an off-by-one here would mark a complete text as clipped, and a
    /// false marker teaches a reader to ignore the true ones.
    #[test]
    fn exactly_at_the_cap_is_not_a_cut() {
        let s = "x".repeat(40);
        let c = keep(&s, 40);
        assert!(!c.happened());
        assert_eq!(c.kept, s);
    }

    /// A paragraph break in the last quarter is the strongest boundary and wins
    /// over the word break that follows it.
    #[test]
    fn a_paragraph_break_is_preferred() {
        let s = format!("{}\n\nand then some more words", "w".repeat(34));
        let c = keep(&s, 40);
        assert_eq!(c.kept, "w".repeat(34));
        assert!(c.happened());
    }

    /// A list item is the shape the brief in `f468f017` was in — a numbered list
    /// with no blank lines between the items — so a single newline has to be a
    /// boundary in its own right.
    #[test]
    fn a_list_item_is_a_boundary() {
        let s = "1. the first thing\n2. the second thing\n3. the third thing";
        let c = keep(s, 40);
        assert_eq!(c.kept, "1. the first thing\n2. the second thing");
        assert!(c.happened());
    }

    /// A word break is the weakest rule and still beats cutting mid-token,
    /// which is the failure the user actually reported.
    #[test]
    fn a_word_break_beats_mid_token() {
        let s = format!("{} tail", "w".repeat(38));
        let c = keep(&s, 40);
        assert_eq!(c.kept, "w".repeat(38));
    }

    /// The floor is the half of the boundary rule that stops it being worse than
    /// no rule. One paragraph break near the start must NOT drag the cut back to
    /// character four — the text is cut where it was always going to be cut.
    #[test]
    fn a_boundary_below_the_floor_is_refused() {
        let s = format!("head\n\n{}", "w".repeat(200));
        let c = keep(&s, 40);
        assert_eq!(c.kept.chars().count(), 40, "the early break was taken: {:?}", c.kept);
    }

    /// Every count is in characters, because that is the unit the caps are
    /// written in. A cap measured in bytes would cut a French name in half and
    /// panic doing it.
    #[test]
    fn counts_are_characters_not_bytes() {
        let s = "é".repeat(50);
        let c = keep(&s, 40);
        assert_eq!(c.total, 50);
        assert_eq!(c.omitted, 10);
        assert_eq!(c.kept.chars().count(), 40);
    }

    /// An em dash mid-cut must not panic, which is the concrete form of the
    /// above and the one `guidance.rs` was written to avoid.
    #[test]
    fn a_multibyte_character_at_the_cut_does_not_panic() {
        let s = format!("{}—{}", "w".repeat(39), "x".repeat(20));
        let c = keep(&s, 40);
        assert!(c.happened());
        assert!(c.kept.chars().count() <= 40);
    }

    /// The marker names the count, the whole size, and a next move. All three
    /// are load-bearing: the count says how much is missing, the total says how
    /// much of the thing you are holding, and the remedy is what stops a reader
    /// inferring the rest instead of asking for it.
    #[test]
    fn the_marker_names_the_loss_and_a_next_move() {
        let s = "w".repeat(100);
        let c = keep(&s, 40);
        let m = c.marked("ask the card that opened you with `send`.");
        assert!(m.contains("60 of 100 characters did not arrive"), "{m}");
        assert!(m.contains("may read as complete and is not"), "{m}");
        assert!(m.contains("ask the card that opened you"), "{m}");
    }

    /// A cut text is trimmed at the join, so the marker does not sit after a
    /// ragged run of spaces left by the boundary rule.
    #[test]
    fn the_join_is_tidy() {
        let s = format!("{}   tail", "w".repeat(37));
        let c = keep(&s, 40);
        assert!(!c.kept.ends_with(' '), "{:?}", c.kept);
    }
}
