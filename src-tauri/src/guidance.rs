//! Standing instructions: what you tell every card once instead of every turn.
//!
//! Two scopes. The **wall's** reach every card on it — "my name is Lyss, I have
//! ADHD, keep answers short" — because those are facts about the person at the
//! keyboard and they do not change when you drag a card from one territory to
//! another. A **territory's** reach the cards standing in it — "this repo is
//! read-only to you", "always run `bun run check` before you claim it builds" —
//! because those are facts about a body of work.
//!
//! There is deliberately no third scope. A per-*card* instruction is a thing you
//! can already say, by saying it, and the card remembers; the whole value of
//! these two is that they survive a card being closed and outlive the session.
//!
//! # Where it is handed over
//!
//! `--append-system-prompt`, on every spawn, composed here. Three alternatives
//! were considered and each loses something this one keeps:
//!
//! - **Writing a `CLAUDE.md`.** This app does not write to the user's
//!   repository, and a project-level instruction that arrives as a tracked file
//!   would end up in a commit and then in a colleague's checkout. The same
//!   argument `hooks.rs` makes about never editing `~/.claude/settings.json`.
//! - **A `SessionStart` hook emitting `additionalContext`.** Works, and puts the
//!   text in the *transcript*, where it accumulates: Skein spawns a process per
//!   wake, so a card woken fifty times over a week carries fifty copies of your
//!   instructions in its own history and pays for them on every turn.
//! - **A `UserPromptSubmit` hook.** The same accumulation, once per turn instead
//!   of once per wake.
//!
//! The system prompt is the one place a standing instruction can sit without
//! being said twice. It is also re-supplied on every spawn, `--resume` included,
//! so editing your instructions is not a thing the transcript has to be
//! rewritten to reflect.
//!
//! **The cost, and it is real: a card already running does not hear an edit.**
//! The text was fixed when its process started. It takes effect the next time
//! that card starts one — a wake from dormant, a clear, a restart — and the
//! panel says so rather than leaving you to notice. Nothing here restarts a
//! live card to apply an edit: that would throw away a turn in flight for a
//! change to a preference, and the whole app's rule is that a card's process is
//! yours to end, not ours.
//!
//! # Read from the store, never passed in
//!
//! `for_conversation` asks the database, inside `spawn_now`, exactly like
//! `kind_of`, `setup_of` and `worktree_of` beside it. `.claude/rules/chat.md`
//! has the argument in full and it is the same one: `open` and `wake` both
//! reach that line and a capability travelling as an argument is one every
//! future call site has to remember. The failure this avoids is a card that
//! comes back from a rouse — at launch, for every dormant card at once — with
//! its project's instructions quietly missing.
//!
//! # These are instructions, not a lock
//!
//! Worth stating because "this project is read-only" is the first thing anybody
//! writes here. A project card spawns with `--dangerously-skip-permissions`, so
//! what is written here is read and followed, not enforced: nothing in this file
//! refuses a tool call. Enforcement would be `permissions.deny` rules in the
//! `--settings` layer `hooks::settings` builds, which is a different feature
//! with a vocabulary of its own to settle. It has not been built.

/// The most one scope may carry, in characters.
///
/// A cap rather than none, because this text goes on the child's command line
/// and Windows' `CreateProcess` takes 32767 UTF-16 units for the *whole* of it —
/// argv that also holds a settings JSON, a resume id and an absolute path to the
/// CLI. Two scopes at this limit plus the frame below is under 9k, so the margin
/// is a factor of three and the failure it prevents is the bad one: a spawn that
/// fails with an OS error naming nothing.
///
/// 4000 is about a thousand words per scope, which is longer than any standing
/// instruction has a right to be and long enough that nobody meets it by
/// accident. The panel counts down against it rather than letting you find out
/// by being truncated.
pub const LIMIT: usize = 4000;

/// Tidy one scope's text on its way into the store: trimmed, and cut to `LIMIT`.
///
/// Cut on a `char` boundary rather than a byte one — `LIMIT` is characters
/// because that is what the panel counts, and slicing a byte range through the
/// middle of a multi-byte character would panic. Somebody's instructions are
/// exactly where an em dash or an accented name shows up.
pub fn clip(text: &str) -> String {
    let text = text.trim();
    match text.char_indices().nth(LIMIT) {
        None => text.to_string(),
        Some((at, _)) => text[..at].trim_end().to_string(),
    }
}

/// The two scopes, composed into the block appended to the system prompt, or
/// `None` when neither has anything to say — which is the ordinary case, and
/// must add no argument at all rather than an empty one.
///
/// The frame around the text is doing three jobs, and each is worth its line.
/// It says the instructions came **from the person**, so they are not read as
/// something the harness wants. It names **which scope** each is from, so an
/// instruction that surprises you can be traced back to where you wrote it
/// without opening two panels. And it settles **precedence** — the narrower
/// scope wins — because the alternative is the model guessing, and the case is
/// neither rare nor hypothetical: a wall that says "keep going, don't check in"
/// against a project that says "ask before you touch anything" is a pair most
/// people would write.
pub fn compose(wall: &str, project: &str) -> Option<String> {
    let wall = wall.trim();
    let project = project.trim();
    if wall.is_empty() && project.is_empty() {
        return None;
    }

    let mut out = String::from(
        "# Standing instructions\n\n\
         The person you are working with set these in Volery, the studio this \
         conversation is a card on. They apply to this whole conversation and \
         they came from them, not from the tooling. Follow them as you would \
         anything else they told you directly.\n",
    );

    if !wall.is_empty() {
        out.push_str("\n## From them, everywhere on this wall\n\n");
        out.push_str(wall);
        out.push('\n');
    }
    if !project.is_empty() {
        out.push_str("\n## From them, for this project in particular\n\n");
        out.push_str(project);
        out.push('\n');
    }
    if !wall.is_empty() && !project.is_empty() {
        out.push_str(
            "\nWhere those two disagree, the project's instruction is the one \
             to follow: it is the more specific of the two and it is the one \
             they wrote about this work.\n",
        );
    }

    Some(out)
}

/// What this card is to be told, read out of the store.
///
/// Both halves fail soft, and that is a judgement rather than laziness: an
/// unreadable row means an instruction is missing, and a card that starts
/// without one is recoverable in a way a card that will not start at all is
/// not. The panel is where you find out whether it took.
pub fn for_conversation(store: &crate::store::Store, id: &str) -> Option<String> {
    let (wall, project) = crate::store::guidance_of(store, id);
    compose(&wall, &project)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_to_say_adds_no_argument() {
        assert!(compose("", "").is_none());
        /* Whitespace is nothing to say. A panel left with a stray newline in it
           must not put an empty section in every card's system prompt. */
        assert!(compose("  \n\t ", "\n\n").is_none());
    }

    #[test]
    fn one_scope_is_still_labelled() {
        let only_wall = compose("call me Lyss", "").unwrap();
        assert!(only_wall.contains("call me Lyss"));
        assert!(only_wall.contains("everywhere on this wall"));
        assert!(!only_wall.contains("for this project"));
        /* No precedence sentence when there is nothing to take precedence over
           — it would be describing a conflict that cannot arise. */
        assert!(!only_wall.contains("disagree"));

        let only_project = compose("", "read only, no edits").unwrap();
        assert!(only_project.contains("read only, no edits"));
        assert!(only_project.contains("for this project"));
        assert!(!only_project.contains("everywhere on this wall"));
        assert!(!only_project.contains("disagree"));
    }

    #[test]
    fn both_scopes_carry_both_texts_and_the_tie_break() {
        let out = compose("keep going without checking in", "ask before editing").unwrap();
        assert!(out.contains("keep going without checking in"));
        assert!(out.contains("ask before editing"));
        assert!(out.contains("disagree"));
        /* The wall is stated first and the project last, so the more specific
           instruction is the nearest thing to the conversation. */
        let wall_at = out.find("keep going").unwrap();
        let project_at = out.find("ask before editing").unwrap();
        assert!(wall_at < project_at);
    }

    #[test]
    fn clip_trims_and_bounds() {
        assert_eq!(clip("  hello  "), "hello");
        assert_eq!(clip("").len(), 0);

        let long = "x".repeat(LIMIT + 500);
        assert_eq!(clip(&long).chars().count(), LIMIT);

        let short = "x".repeat(LIMIT);
        assert_eq!(clip(&short).chars().count(), LIMIT);
    }

    #[test]
    fn clip_counts_characters_and_never_splits_one() {
        /* The case that would panic on a byte slice: every character is three
           bytes, so the byte length is three times the limit and the cut lands
           mid-character if the arithmetic is done in bytes. */
        let wide = "é".repeat(LIMIT + 10);
        let out = clip(&wide);
        assert_eq!(out.chars().count(), LIMIT);
        assert!(out.chars().all(|c| c == 'é'));
    }

    #[test]
    fn a_composed_pair_stays_well_inside_the_command_line() {
        /* The bound `LIMIT` exists for. Windows takes 32767 UTF-16 units for the
           whole argv, and this is the largest thing in it. */
        let big = "x".repeat(LIMIT);
        let out = compose(&big, &big).unwrap();
        assert!(out.encode_utf16().count() < 12_000, "composed {} units", out.encode_utf16().count());
    }
}
