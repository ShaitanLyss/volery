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
//! # These are instructions, and beside them there is now a lock
//!
//! "This project is read-only" was the first thing anybody wrote here, and for
//! a while it was prose in a system prompt: read and followed, never enforced,
//! on a card carrying `--dangerously-skip-permissions`. The territory's lock
//! (sink `8dde1cc1`) is the enforcing half — three names in a `permissions.deny`
//! array in the `--settings` layer `hooks::settings` builds, and that is the
//! whole mechanism. It is set in this panel because it is the same thought at
//! the same scope, and the two must not be able to disagree.
//!
//! **The lock needs this file, which is the part that is not obvious.** Measured
//! against 2.1.233 (`tools/probe-lock.ts`): a denied tool is not offered and
//! then refused, it is *absent from the card's tool list*. That is the better
//! mechanism — nothing to pay for, and the card plans around it rather than
//! being stopped mid-plan — but it is mute. "Not in my tool list" is
//! indistinguishable from a CLI that never had the tool, so a locked card cannot
//! tell the user *why* it will not edit, and the probe watched one spend two
//! `ToolSearch` calls looking for a `Write` that had been taken away from it.
//! So `compose` says the lock is on, in words, and the settings layer makes it
//! true. Neither half is redundant: the sentence without the deny is what this
//! feature already was, and the deny without the sentence is a card that has
//! quietly lost a capability and does not know it.
//!
//! What the lock does **not** deny is the shell — a card with no `git log`, no
//! `rg` and no `bun test` is not read-only, it is broken — and a blocklist of
//! writing shell verbs is a promise about what the switch means rather than an
//! implementation detail. That question was asked and is held: sink `b3230b03`.

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
///
/// **And it must say when it has cut**, which it did not until 2026-09-04. Of
/// all the budgets on this wall this is the one where silence costs most: these
/// are the user's *standing instructions*, they go into a system prompt, and a
/// model given three quarters of them follows three quarters of them with total
/// confidence and no way to know a fourth is missing. The person who wrote them
/// is not in the conversation to notice. So the marker is addressed to the model
/// — it is the only party present who can act on it, and what it should do is
/// say so rather than guess at the rest.
pub fn clip(text: &str) -> String {
    crate::clip::keep(text.trim(), LIMIT).marked(
        "These are the user's standing instructions and the wall could not carry all of \
         them. Follow what is here, and tell the user their guidance is longer than the \
         limit and has been cut — do not try to infer what the rest said.",
    )
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
pub fn compose(wall: &str, project: &str, locked: bool) -> Option<String> {
    let wall = wall.trim();
    let project = project.trim();
    if wall.is_empty() && project.is_empty() && !locked {
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

    /* Last, after whatever they wrote, because it is the one line here that is
       not a preference: it is a fact about what this card can do, and an
       instruction that contradicts it has already lost.

       **It says what has been taken away and names it.** The card cannot work
       this out for itself — `hooks::settings` denies by *withholding*, so the
       tools are simply not in its list, which reads exactly like a CLI that
       never had them. A card that does not know it is locked answers "I don't
       seem to have a Write tool", which is true and useless; one that knows can
       say what the user actually needs to hear.

       And it says what to do instead, because the failure this replaces is not
       an agent that edits anyway — it cannot — but an agent that stops. Writing
       the patch out is the whole of what a read-only card is for. */
    if locked {
        out.push_str(
            "\n## This territory is locked read-only\n\n\
             They have set this project read-only in Volery, so `Edit`, `Write` \
             and `NotebookEdit` have been taken away from you — that is why those \
             tools are not in your list, rather than anything being broken. It is \
             a deliberate setting of theirs and not something to work around.\n\n\
             You can still read anything, search, and run commands. **Do the work \
             and hand back the change rather than stopping**: say exactly what you \
             would alter, in which file, and write the new text out in full so \
             they can apply it. If you think the lock is in your way, say so and \
             let them decide — it is one switch in the standing-instructions \
             panel.\n",
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
pub fn for_conversation(
    store: &crate::store::Store,
    id: &str,
    locked: bool,
) -> Option<String> {
    let (wall, project) = crate::store::guidance_of(store, id);
    compose(&wall, &project, locked)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_to_say_adds_no_argument() {
        assert!(compose("", "", false).is_none());
        /* Whitespace is nothing to say. A panel left with a stray newline in it
           must not put an empty section in every card's system prompt. */
        assert!(compose("  \n\t ", "\n\n", false).is_none());
    }

    #[test]
    fn one_scope_is_still_labelled() {
        let only_wall = compose("call me Lyss", "", false).unwrap();
        assert!(only_wall.contains("call me Lyss"));
        assert!(only_wall.contains("everywhere on this wall"));
        assert!(!only_wall.contains("for this project"));
        /* No precedence sentence when there is nothing to take precedence over
           — it would be describing a conflict that cannot arise. */
        assert!(!only_wall.contains("disagree"));

        let only_project = compose("", "read only, no edits", false).unwrap();
        assert!(only_project.contains("read only, no edits"));
        assert!(only_project.contains("for this project"));
        assert!(!only_project.contains("everywhere on this wall"));
        assert!(!only_project.contains("disagree"));
    }

    #[test]
    fn both_scopes_carry_both_texts_and_the_tie_break() {
        let out = compose("keep going without checking in", "ask before editing", false).unwrap();
        assert!(out.contains("keep going without checking in"));
        assert!(out.contains("ask before editing"));
        assert!(out.contains("disagree"));
        /* The wall is stated first and the project last, so the more specific
           instruction is the nearest thing to the conversation. */
        let wall_at = out.find("keep going").unwrap();
        let project_at = out.find("ask before editing").unwrap();
        assert!(wall_at < project_at);
    }

    /// The lock is the one thing here that is not a preference, so it has to be
    /// said whether or not anybody wrote anything.
    ///
    /// The empty case is the one that would have been missed: a territory with
    /// no instructions at all and the switch on used to be `None`, which is no
    /// `--append-system-prompt` at all — a card locked and never told.
    #[test]
    fn a_locked_territory_says_so_with_nothing_else_to_say() {
        let out = compose("", "", true).expect("a locked card is told");
        assert!(out.contains("locked read-only"), "{out}");
        /* The three names, because "you cannot edit" leaves a card guessing at
           which of its tools went and reaching for the others. */
        for tool in ["Edit", "Write", "NotebookEdit"] {
            assert!(out.contains(tool), "the lock did not name {tool}: {out}");
        }
        /* The half that stops it being a card that gives up: it cannot apply the
           change, so the change has to come back in words. */
        assert!(out.contains("hand back the change"), "{out}");
        /* And the reason the sentence exists at all — the deny withholds rather
           than refuses, so nothing else would tell the card this was on purpose
           (`tools/probe-lock.ts`). */
        assert!(out.contains("rather than anything being broken"), "{out}");
    }

    /// Unlocked is silent. The lock's paragraph on every card in every territory
    /// would be the same words paid for everywhere to say "no".
    #[test]
    fn an_unlocked_territory_says_nothing_about_locks() {
        assert!(compose("", "", false).is_none());
        let out = compose("call me Lyss", "", false).unwrap();
        assert!(!out.contains("read-only"), "{out}");
    }

    /// The lock goes last, after whatever they wrote.
    ///
    /// Not cosmetic: an instruction that says "edit the file" and a lock that
    /// says the tool is gone are a contradiction, and the one that must win is
    /// the one that is true. The panel's own precedence sentence stays where it
    /// is — it settles wall against project, which is a different question.
    #[test]
    fn the_lock_is_the_last_word() {
        let out = compose("go ahead and edit", "edit freely", true).unwrap();
        let project_at = out.find("edit freely").expect("the project's text");
        let lock_at = out.find("locked read-only").expect("the lock");
        assert!(project_at < lock_at, "{out}");
    }

    #[test]
    fn clip_trims_and_bounds() {
        assert_eq!(clip("  hello  "), "hello");
        assert_eq!(clip("").len(), 0);

        /* Over the limit: the text is cut to `LIMIT` and a marker follows, so
           the result is longer than `LIMIT` by exactly the marker. Asserting on
           the *kept* characters rather than the total is the point — the marker
           is not part of the user's instructions. */
        let long = "x".repeat(LIMIT + 500);
        let out = clip(&long);
        assert_eq!(out.matches('x').count(), LIMIT);
        assert!(out.contains("standing instructions"), "{out}");

        /* Exactly on the limit is not over it, so nothing is added. A false
           marker here would have a model announce that guidance was cut when it
           was whole. */
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
        assert_eq!(out.matches('é').count(), LIMIT);
        assert!(out.contains("cut"), "the loss was not announced: {out}");
    }

    #[test]
    fn a_composed_pair_stays_well_inside_the_command_line() {
        /* The bound `LIMIT` exists for. Windows takes 32767 UTF-16 units for the
           whole argv, and this is the largest thing in it. */
        let big = "x".repeat(LIMIT);
        let out = compose(&big, &big, false).unwrap();
        assert!(out.encode_utf16().count() < 12_000, "composed {} units", out.encode_utf16().count());
    }
}
