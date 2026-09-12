//! Characters that cannot be recorded, and taking them out.
//!
//! Every text on this wall is written by one party and read by another, and on
//! nearly every path through this app **both of them are agents**. That is what
//! makes a stray control character cost more here than it costs most
//! applications. A NUL in a sink item is not a rendering curiosity: it goes
//! back out in a `tools/call` result, into the reading card's conversation, and
//! from there into that card's next request — which the API refuses.
//! `repair.rs` exists to mend exactly that conversation. This module exists so
//! the wall stops being one of the places it comes from.
//!
//! ## What happened
//!
//! Sink item `31504316` is a nova card's note about a Tailwind build failure,
//! and the failure it pasted carried four raw bytes of its own — `U+0003`,
//! `U+0013` and two NULs, inside a quoted `&[data-…]` selector that
//! lightningcss had echoed back out of a file it could not parse. Nothing on
//! the way in looked at them. So `sink --kind bug` answered 178 KB with a NUL
//! at offset 48,722, ripgrep refused the result as binary, and **one item took
//! the whole listing down for every card on the wall** — the sink's one
//! promise, that a finding outlives the card that made it, broken for every
//! other finding in the pile by an accident in one of them. Filed as sink
//! `3937d33d`.
//!
//! ## What counts as impossible
//!
//! The C0 controls and DEL, except tab, newline and carriage return. That is
//! the same line `repair::text::bad_counts` draws and for the same reason:
//! every tool result on the wall is full of the three that survive, and there
//! is no honest way for any of the rest to be in a text somebody meant to
//! write. Nothing types one and nothing means one.
//!
//! **U+FFFD is deliberately not scrubbed here, and `repair` does take it out.**
//! The divergence is the point rather than an oversight. There, the replacement
//! character is *evidence*: the CLI put it in because a tool's output would not
//! decode, so the record is already damaged and a screenful of them says how
//! badly. Here the text is prose a person or an agent composed, and prose about
//! an encoding legitimately contains one. A replacement character is legal
//! text; a NUL is not. The two questions only look alike.
//!
//! ## Removed rather than refused, and rather than marked
//!
//! Refusing the write would cost the card its finding over a byte it did not
//! intend and cannot see. The nova card believed it had filed a build failure,
//! and it had.
//!
//! Marking it is the harder call, because `clip.rs` next door is emphatic that
//! a text altered on its way to a reader is owed a marker at both ends — and
//! that rule is right, where it applies. It does not reach this. A clip removes
//! **meaning the reader needs and the writer still holds**, so telling either
//! of them is something they can act on. A scrub removes a character that
//! carried meaning for neither: the marker would be noise in the body on the
//! read side and a line about nothing in the receipt on the write side. So this
//! is silent, and says so here rather than leaving the next reader to wonder
//! whether the asymmetry was noticed.
//!
//! ## Both ends, because they cover different things
//!
//! - **Writing.** `clip::keep`, which every capped text field on every surface
//!   already passes through — including the ones the *user* types into, which
//!   an agent-side guard would miss and which are just as easy to paste a build
//!   log into. Then `ask::dispatch`, which catches the MCP arguments no cap
//!   applies to: globs, ids, an Asana task's name, a question parked for the
//!   user.
//! - **Reading.** `ask::respond`, which is what keeps a listing readable when
//!   something got in anyway — text that never passed a write at all, like a
//!   git error or a server log quoted into a receipt, and the rows already in
//!   the store when this shipped. `store::migrate_v34` heals those; this is
//!   what makes the heal unnecessary for correctness rather than load-bearing.
//!
//! Nothing here reaches into the crate, which is what lets `tools/lift-clip.ts`
//! compile it whole with `rustc --test` on a machine that cannot run `cargo
//! test` at all. See `.claude/rules/clipping.md`.

use std::borrow::Cow;

/// Can this character be stored and handed to another party?
///
/// Tab, newline and carriage return are ordinary text everywhere on this wall
/// and are not touched; every other C0 control, and DEL, is something nobody
/// wrote on purpose.
pub fn impossible(c: char) -> bool {
    let n = c as u32;
    n == 0x7f || (n < 0x20 && c != '\t' && c != '\n' && c != '\r')
}

/// The same text with the impossible characters gone.
///
/// Borrows when there is nothing to do, which is very nearly every call: this
/// sits on `clip::keep` and on both ends of every MCP request, so the clean
/// path has to cost a scan and no allocation.
///
/// The scan is over **bytes** and the rebuild is over **characters**, and that
/// is not an inconsistency. Every byte this looks for is below `0x20` or is
/// `0x7f`, and UTF-8 never encodes any part of a multi-byte character below
/// `0x80` — so a byte scan cannot produce a false positive on an accented name
/// or a CJK string, and it is the scan that runs on a 178 KB listing. The
/// rebuild is the rare path and takes the obvious spelling.
pub fn scrub(s: &str) -> Cow<'_, str> {
    let dirty = s
        .as_bytes()
        .iter()
        .any(|b| *b == 0x7f || (*b < 0x20 && *b != b'\t' && *b != b'\n' && *b != b'\r'));
    if !dirty {
        return Cow::Borrowed(s);
    }
    Cow::Owned(s.chars().filter(|c| !impossible(*c)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The common case allocates nothing. Stated as an assertion rather than
    /// left to the implementation, because this runs on every MCP response
    /// including the sink's whole listing, and a `to_string()` here would be
    /// invisible until it was a copy of every byte on the wall per tool call.
    #[test]
    fn clean_text_is_borrowed_rather_than_rebuilt() {
        assert!(matches!(
            scrub("an ordinary sentence\nwith a newline\tand a tab"),
            Cow::Borrowed(_)
        ));
    }

    /// The byte that started it.
    #[test]
    fn a_nul_does_not_survive() {
        assert_eq!(scrub("before\u{0}after"), "beforeafter");
    }

    /// The other three from the real item, and DEL, which is the one outside
    /// the C0 range and therefore the one a `< 0x20` test on its own misses.
    #[test]
    fn the_rest_of_the_impossible_ones_go_too() {
        assert_eq!(scrub("a\u{3}b\u{13}c\u{7f}d\u{1b}e"), "abcde");
    }

    /// The three that are ordinary text. Every tool result on the wall is full
    /// of them, and a scrub that took them would reflow the whole transcript.
    #[test]
    fn tab_newline_and_carriage_return_are_text() {
        let s = "one\ttwo\r\nthree";
        assert_eq!(scrub(s), s);
    }

    /// `repair::text::stripped` takes this out and this does not, and the
    /// difference is argued at the top of the file. A sink item about an
    /// encoding is entitled to contain one.
    #[test]
    fn the_replacement_character_is_left_alone() {
        let s = "the log came back as \u{FFFD}\u{FFFD}\u{FFFD}, so the capture is wrong";
        assert_eq!(scrub(s), s);
    }

    /// The byte scan's correctness claim, exercised rather than reasoned
    /// about: a string of multi-byte characters with one NUL in it loses the
    /// NUL and nothing else.
    #[test]
    fn multibyte_characters_are_not_mistaken_for_control_bytes() {
        assert_eq!(scrub("Lagardère · 日本語 · —\u{0}"), "Lagardère · 日本語 · —");
    }

    /// The item itself, as far as it can be reproduced here — the point being
    /// that what is left is the sentence the card meant to file.
    #[test]
    fn the_item_that_took_the_listing_down_comes_back_readable() {
        let body = "&[data-\u{3}\u{13}=\"\u{0}\u{0}\"] { Unexpected token in attribute selector";
        assert_eq!(
            scrub(body),
            "&[data-=\"\"] { Unexpected token in attribute selector"
        );
    }

    /// An empty string and an all-control string are both fine, and the second
    /// one is the shape a truncated binary paste takes.
    #[test]
    fn a_text_that_was_nothing_but_controls_becomes_empty() {
        assert_eq!(scrub(""), "");
        assert_eq!(scrub("\u{0}\u{1}\u{2}"), "");
    }
}
