//! A card putting a card on the wall.
//!
//! This wall's whole thesis is that concurrent conversations are the unit of
//! work, and until now only *you* could start one. An agent that has decomposed
//! a job into four independent pieces has one move: do them one after another in
//! its own context, or spawn subagents that live inside its turn, report back
//! through it, and vanish. Neither is a card. Neither can be looked at, talked
//! to, sent a message, or left running while you go and read something else.
//!
//! So `spawn` — and it is the most consequential tool on this server, which is
//! what most of this file is about.
//!
//! ### What it deliberately cannot do
//!
//! A project card spawns with `--dangerously-skip-permissions`. A tool that let
//! an agent choose *where* a new one of those stands by writing a path would be
//! a tool that lets a model pick a directory and be handed the machine in it —
//! and the path would arrive through whatever the agent has been reading all
//! turn. So:
//!
//! - **The child stands on the wall.** Either where the parent stands, which is
//!   the default and no argument at all, or in one of the wall's own
//!   territories, named. Not a subdirectory, not a sibling, and never a path the
//!   caller writes: `project` is matched against `store::projects` and a needle
//!   that matches nothing is refused with the list of what would have. The bound
//!   that cannot be argued around is no longer "the parent's cwd" but **the
//!   user's own declaration of where they work here** — a territory is on the
//!   wall because they opened it and stays until they forget it, so the set of
//!   reachable directories is a thing they curated rather than a thing a model
//!   composed. It buys the case the whole wall is for: a card in `atelier` that
//!   has worked out what `nova` and `caravan` each need can open a card in each,
//!   rather than describing the work and waiting to be asked.
//! - **A chat card may not spawn at all.** It reaches nothing on this machine on
//!   purpose (`.claude/rules/chat.md`), and a chat card opening a project card
//!   would be a line from the open web to a shell — the same hole `relay.rs`
//!   refuses `send` and `list` to close, one layer further up. Decided by asking
//!   the store what kind of card the caller is, never by trusting the caller,
//!   which is the rule `spawn_conversation` already follows.
//!
//! And **one generation** was here until recently — a card an agent opened could
//! not open one of its own — which makes it the third bound to come off and the
//! last one that refused anything about *how much*. Its argument is kept whole
//! over `ONE_GENERATION`, because it is the argument that would justify bringing
//! something back and it recommends `MAX_LIVE` rather than a depth counter.
//!
//! ### And what it cannot help doing
//!
//! It costs money without asking. That is true of `send` too, and of a
//! broadcast, and the answer here was three things: bound it, make it visible,
//! and say what it cost in the receipt. Two of those are all that is left. Both
//! numbers are off (`MAX_LIVE`, `MAX_PER_HOUR`) and what carries the weight now
//! is that **every spawned card is *a card***: on the wall, with a title, in
//! `list`, named by the perf meter, closed by the same gesture as any other.
//! Nothing about it is hidden, which is the difference between this and a
//! subagent — **a fan-out you can see is a fan-out you can stop.** That was
//! always the load-bearing half; the numbers were the belt to its braces.
//!
//! What still refuses is the pair that are about *what a card is* rather than
//! about how much of it there is: **where it may stand** (a territory on the
//! wall, never a path a model wrote) and **no chat card** (which would be a line
//! from the open web to a shell). Neither is a guess and neither has a number in
//! it, which is exactly why they are the two that survived — a shape argument
//! does not need one to be right.
//!
//! ### Rust decides; the wall opens
//!
//! `Skein.#openIn` is the one correct way a card comes into being — ensure the
//! project, write the row *before* the spawn so `spawn_conversation` can ask the
//! store what kind of card it is, resolve the account off the waterfall, mint
//! the `Conversation`, load its history. Reproducing any of that here would be a
//! second birth path, and the one that drifts is the one nobody is looking at.
//!
//! So this checks the guards, mints the id, records the parentage, and emits.
//! **Minting the id here is what makes the receipt useful**: the agent is handed
//! the child's handle in the same call, so it can `send` to it or `recall` it
//! without a round of `list` and a guess about which card is new.
//!
//! ### And closing one again
//!
//! `close` is the other end, and it used to have exactly one rule: **a card may
//! close what it opened and nothing else.** Not the card that opened it, not a
//! sibling, not one of the user's, and not itself. That single condition was
//! what made the tool safe enough to exist without a rate limit or a
//! confirmation of its own — every card it could reach was one it had asked for,
//! so the worst it could do was undo its own work.
//!
//! **That rule was right about the danger and wrong about the wall.** It was
//! written while `MAX_LIVE` still bit, when the case in front of it was a parent
//! holding a slot it could not use. With the caps off, the failure this runs
//! into first is the opposite one: nothing clears a finished card except the
//! user doing it by hand, and on a wall of twenty cards the ones plainly worth
//! tidying are mostly *not* the caller's. An agent that could see a dead card
//! and not name it had one move — say so in prose and hope somebody acted — and
//! tidying that has to be asked for in prose is tidying that does not happen.
//!
//! So the authority moved rather than came off. **A card may name any card, and
//! parentage now decides who says yes rather than whether anyone can.**
//!
//! - **A card it opened** closes at once, exactly as before.
//! - **Any other card** parks the `tools/call` and puts the question to the
//!   user — which card, who wants it gone, the reason the caller gave, and what
//!   closing actually does. Approved, it closes; declined, the caller is told
//!   they were asked and said no. Same mechanism as `ask_user`, because it *is*
//!   `ask_user`'s mechanism: `ask::park_and_stream` gained one parameter so
//!   something other than a question can hold a request open. See
//!   `.claude/rules/ask.md`.
//!
//! Nothing closes on an agent's word alone that did not close on it before. What
//! changed is that a refusal became a question with a default of no, which is
//! the difference between a tool that cannot help and one that can offer.
//!
//! Three cards are still refused outright rather than put to anybody, and the
//! test of which is whether a person could usefully answer (`may_close`):
//!
//! - **Itself.** A card tidying itself away would take its own transcript off
//!   the wall at the moment the user might be reading it, and it is the user's
//!   wall.
//! - **Set aside.** It is the one flag on a card that is an explicit human
//!   intention rather than a fact about the work — the user saying they are
//!   coming back to it. Asking them to approve overriding a decision they have
//!   already made is not a question, it is nagging.
//! - **Mid-turn.** An agent part-way through does not stop cleanly, and a person
//!   cannot judge from a one-line question whether the turn matters either — so
//!   putting it to them would be handing over a decision with the evidence left
//!   out. Waiting costs the caller nothing.
//!
//! And what it is not: **closing is not deleting.** The row is marked rather
//! than removed and the transcript stays where Claude Code wrote it, so the
//! session can be adopted back (`sessions.rs`). The description says so in those
//! words, and the *question* says so again in its own, because an agent that
//! thinks the tool destroys work will avoid one it should use — and a user asked
//! whether to "close" something they cannot see will say no to all of them.
//!
//! The wall does the closing, for the reason it does the opening — and here it
//! matters more. `Skein.close` takes the card off the wall *before* the three
//! bookkeeping calls, which is a bug that shipped once already (`restore.md`);
//! reproducing that ordering in Rust would be a second path that has to keep
//! remembering it. So this resolves the address, checks the guards and emits
//! `close:asked`, and the wall closes it exactly as your own gesture does — save
//! for one thing the wall decides for itself, and it is worth knowing about from
//! here: a card taken off by an agent *fades*, where one you closed goes at once.
//! Nothing on this side says so or could. The listener passes `"agent"` and the
//! rest is paint (`restore.md`, "An agent's close fades; yours goes at once").

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::store::Store;

pub const SPAWN_TOOL: &str = "spawn";
pub const CLOSE_TOOL: &str = "close";

/* ── the three switches, and none of them is on ────────────────────────────
 *
 * How many at once, how fast, and how deep. All three were guesses, and all
 * three are parked rather than deleted: one word to turn any of them back on,
 * and the guards below are written as bounds that may not exist rather than as
 * comparisons a sentinel happens to slip through. Everything that feeds them
 * still runs — `record_spawn` writes every spawn down, so a cap restored
 * tomorrow is correct about today.
 *
 * **What bounds a fan-out now is the wall.** Every spawned card is *a card*: on
 * the wall, with a title, in `list`, named by the perf meter, closed by the same
 * gesture as any other. A fan-out you can see is a fan-out you can stop, and
 * that argument was always the load-bearing half — the numbers were the belt to
 * its braces. Two things do still refuse, and they are the ones that are not
 * guesses: **one generation** (a card an agent opened may not open more, so
 * nothing here is the first term of a series) and **no chat card** (which would
 * be a line from the open web to a shell). Those are about *shape*, and a shape
 * argument does not need a number to be right.
 *
 * If this backfires it will backfire as a wall you cannot read — which is a
 * thing you look at, rather than a thing a limit tells you about after the fact.
 */

/// How many of one card's children may be on the wall at once, or `None` for as
/// many as it likes.
///
/// **Off, and this is what it was**: four. It was about how much is *running* at
/// once, and it was a guess at how much concurrency one card's work divides
/// into — a guess that mostly showed up as a parent blocked from opening a fifth
/// card while its finished children stood on the wall waiting for somebody to
/// close them. `close` answers that from the right end.
const MAX_LIVE: Option<i64> = None;

/// How many spawns one card may ask for in an hour, drawn or not, or `None` for
/// as many as it likes.
///
/// **Off, and this is what it was**: six. This was the better-shaped of the two —
/// a rate rather than a count, and the only one that could see the failure a live
/// cap cannot tell apart from ordinary work: a card asking for cards in a loop,
/// including one whose spawns silently never drew, which is why it counted asks
/// rather than cards. What it could not do is tell that loop from a genuine
/// decomposition into seven pieces, and it answered both with the same refusal.
///
/// So the loop it was for is now something you *see* — seven cards arriving at
/// once on a wall is a thing on a wall — and `store::spawns_since` is kept, with
/// no caller, for the hour this comes back.
const MAX_PER_HOUR: Option<i64> = None;
const HOUR_MS: i64 = 60 * 60 * 1_000;

/// May a card that was itself opened by an agent open cards of its own?
///
/// **Off**, so it may, and so may its children — there is no depth bound
/// anywhere on this path now. Parked in the same style as the two numbers, and
/// the argument it used to make is worth keeping intact rather than paraphrased,
/// because it is the one that would justify bringing something back:
///
/// > The **branching** is the problem rather than the depth. A handful of cards
/// > each opening a handful is dozens of agents on one prompt and then hundreds,
/// > and a depth limit set at six would let all of it through, because every
/// > spawn is a first.
///
/// That is still true. What has changed is not the arithmetic but who is
/// watching it: with this on, the tree could not grow and nobody had to look;
/// with it off, **the wall is the instrument** — every card in that tree is a
/// card on it, and a wall filling up is a thing you see rather than a number
/// somebody has to have guessed right in advance.
///
/// So if this is ever wanted back, note what the reasoning above actually
/// recommends: not a depth counter, which is the wrong instrument, but
/// `MAX_LIVE` — a bound on how wide any one card may go, applied at every
/// generation. The flag here is the blunt version and is kept only because it is
/// what was already written.
const ONE_GENERATION: bool = false;

/// How long a brief may be.
///
/// **Off, and this is the fourth bound to come off** — see `MAX_LIVE`,
/// `MAX_PER_HOUR` and `ONE_GENERATION`, which are parked the same way and for
/// the same reason: the number was a guess, and what it actually refused was
/// the good case.
///
/// It was four thousand characters, cut with `chars().take(n)` and no marker of
/// any kind. What that did on 2026-09-02 is sink `f468f017`: a numbered brief of
/// load-bearing ideas arrived at a card cut off inside the word `ask_user`,
/// items seven onward never arrived, and **nothing told either end**. The child
/// inferred the rest of the sentence and carried on, which is the failure mode
/// rather than the escape — a brief clipped at a *paragraph* boundary would have
/// read as complete, and then nobody would ever have known.
///
/// The argument for having a cap at all was that a brief is a model's output and
/// therefore unbounded. It is not: this arrives as MCP `tools/call` arguments,
/// so the brief was written by the caller inside its own output budget, and it
/// is *already* paid for by the time this function sees it. Clipping it here
/// does not save the user a token — the money is spent — it only throws away the
/// half the parent thought it was sending. And the whole argument of the
/// `prompt` field is that the brief is the entire channel: the child gets no
/// context, no history and nothing the user said, so the one thing a cap here
/// can reliably remove is the paragraph that would have made the card worth
/// opening.
///
/// So the bound is the agent's judgement and the tool's description, which says
/// so in as many words — `the_brief_says_it_is_not_clipped` holds it to that,
/// the same way `the_description_says_there_is_no_limit` holds the quantity
/// bound to saying it is gone.
///
/// **`clip_brief` is kept with no live caller**, exactly as `spawns_since` is
/// kept for `MAX_PER_HOUR`. Turning this back on is one word, and on the day it
/// happens the clipping is already boundary-aware and already announces itself
/// at both ends — which is the half that was missing, and the half a `Some(n)`
/// written in a hurry would not think to add.
const MAX_PROMPT: Option<usize> = None;

/// How long a *title* may be, which is a different question and still has an
/// answer.
///
/// A title is furniture: it is drawn in a fixed box on a card at four densities
/// and read at a glance, so there is a real width past which more characters are
/// not more information. Unlike a brief, nothing is lost by cutting one — the
/// card renames itself from its own first turn anyway (`naming.md`), so this is
/// a label with hours to live.
const MAX_TITLE: usize = 80;

#[derive(Clone, Serialize)]
struct SpawnAsked {
    /// The id the wall must use, so the handle in the receipt is the handle of
    /// the card that appears.
    id: String,
    parent_id: String,
    /// Where the child stands: the parent's own directory, or the root of a
    /// territory the parent named — resolved here against `store::projects`,
    /// never a string the caller wrote. See the module note.
    cwd: String,
    /// The branch's tree the child works in, which is the parent's own or
    /// nothing. Only ever inherited when the child stands *here*: a card opened
    /// in another territory has no business carrying this one's branch name,
    /// and `worktree::ensure` would make a tree for it there.
    worktree: Option<String>,
    /// Its first turn.
    prompt: String,
    /// What to call it until it has named itself, or null.
    title: Option<String>,
}

#[derive(Clone, Serialize)]
struct CloseAsked {
    /// The card to take off the wall. Resolved here from whatever the caller
    /// wrote, so the wall is handed an id and never an address.
    id: String,
    /// Who asked, for the wall to say so if it ever wants to.
    parent_id: String,
}

pub fn spawn_schema() -> Value {
    json!({
        "name": SPAWN_TOOL,
        "description":
            "Open another conversation on this Skein wall and give it a piece of work. It \
             becomes a real card beside yours: the user can watch it, read it, talk to it, \
             and you can `send` to it or `recall` it by the handle this returns.\n\n\
             **This is not a subagent.** A subagent lives inside your turn, reports through \
             you and disappears; a card outlives your turn, has its own context and its own \
             transcript, and is still there tomorrow. Use `Agent` for work whose *answer* you \
             need in order to carry on. Use this for work that is genuinely a separate job — \
             a second feature, a long migration, an investigation that should not be \
             interleaved with yours.\n\n\
             It costs the user money and attention without asking, so treat it as you would \
             a broadcast. **Tell them you are opening a card, and why, before or in the same \
             reply.** Two or three is a decomposition; eight is a fan-out nobody asked for.\n\n\
             By default the new card stands in this conversation's own working directory. \
             `project` stands it in another of the wall's territories instead — one the user \
             has already opened here, named as `list` names it — so a card that has worked \
             out what two other repositories each need can open a card in each. You cannot \
             point it at an arbitrary path, only at somewhere already on this wall.\n\n\
             **Nothing limits how many of these there can be**, and a card you open can open \
             cards of its own. That is a decision about the wall rather than about you: it \
             means every card that gets opened is one somebody decided was worth a card, and \
             the only thing standing between a decomposition and a hundred agents on one \
             prompt is your judgement. Open what the work is actually divided into. Close \
             them with `close` when they have reported.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "prompt": {
                    "type": "string",
                    "description":
                        "The whole of what the new conversation gets. It shares your \
                         repository and that territory's standing instructions, and nothing \
                         else of yours — not your context, not what the user told you, not \
                         what you have worked out — so write it as a brief to somebody who \
                         has just walked in: what to do, which files, what 'done' looks \
                         like, and anything you have already ruled out. A one-line prompt \
                         spends a whole card rediscovering what you already know.\n\n\
                         **What is true of every card in that repository does not belong \
                         here.** How to commit, which gates to run, what to leave alone: \
                         that is the territory's standing instructions, which the user \
                         writes once (right-click the territory) and every card started \
                         there is handed. Opening several cards on one job, ask for those \
                         rather than repeating a paragraph into each brief — copies drift, \
                         and the earliest go stale first. A card already running does not \
                         hear an edit, so they reach the cards you open next and not those \
                         already on the wall.\n\n\
                         **Nothing clips this and there is no length to write to.** Write \
                         the brief the work actually needs — the numbered list, the file \
                         paths, the thing you already tried that did not work. It arrives \
                         whole, in one piece, as the card's first turn. Do not summarise a \
                         brief down to fit a size you are guessing at: the card cannot ask \
                         you what you left out until it knows something is missing, and a \
                         brief that stops at a paragraph boundary reads as complete."
                },
                "project": {
                    "type": "string",
                    "description":
                        "Optional. Which of the wall's territories the card stands in — a \
                         project name exactly as `list` reports it ('nova', 'caravan'), or \
                         its full root path. Omit it and the card stands where you do, which \
                         is the usual case; name one when the work genuinely belongs to \
                         another repository, and remember the card that arrives there knows \
                         only what your brief tells it. It must be a project the user has \
                         already opened on this wall: an arbitrary directory is refused, and \
                         so is a name that matches nothing — which is answered with the list \
                         of what is here."
                },
                "title": {
                    "type": "string",
                    "description":
                        "Optional. What to call the card until it names itself — a few \
                         words, so the user can tell your cards apart at a glance on the \
                         wall."
                }
            },
            "required": ["prompt"]
        }
    })
}

pub fn close_schema() -> Value {
    json!({
        "name": CLOSE_TOOL,
        "description":
            "Take a card off the wall, when the work it was opened for is done.\n\n\
             **A card you opened closes on your say-so. Any other card asks the user \
             first** — the call stops, they are shown which card, who wants it gone and the \
             reason you gave, and they decide. So you may name any card on the wall, and \
             naming one that is not yours is not an error: it is you offering, which is the \
             right thing to do about a card that has plainly finished. What you must not do \
             is treat that as free. Every ask spends the user's attention and parks your own \
             turn until they answer, so offer where you would have said 'that one looks \
             done' out loud, and not card by card down a wall you have never read.\n\n\
             **This is not deleting anything.** The card leaves the wall and its process \
             ends; the transcript stays exactly where Claude Code wrote it and the session \
             can be adopted back at any time. What you are taking is the space and the \
             attention, which is the thing worth tidying: a card left standing after it has \
             reported is one the user has to read past on a wall where everything is \
             supposed to be live work.\n\n\
             Say what you closed and why, in the reply where you closed it — and say so too \
             when you asked and they said no. A card disappearing from the wall with nothing \
             said about it is the user losing track of their own studio.\n\n\
             **You may offer yourself, the same as any other card.** It is put to the \
             user like anything else — say in the reply that you have offered, since your \
             transcript may be what they are looking at while they answer, and it will be \
             gone if they say yes.\n\n\
             Two cards are refused outright rather than put to anybody: one that is \
             **mid-turn**, because an agent part-way through does not stop cleanly; and one \
             the user has **set aside**, which is them saying they are coming back to it. \
             Both hold however asks, your own card included.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "card": {
                    "type": "string",
                    "description":
                        "Which card, by the handle `spawn` gave you or `list` reports, or by \
                         its exact title. It may be any card on the wall; one you did not \
                         open is put to the user before anything happens to it."
                },
                "why": {
                    "type": "string",
                    "description":
                        "One line on why this card should go — what it finished, or what \
                         makes it dead. Ignored for a card you opened, and the whole of what \
                         the user has to go on for one you did not: they are being asked \
                         about a card they may not have looked at in hours, and a question \
                         carrying no reason is one they can only answer by going and reading \
                         it. Say what happened, not that it is tidy."
                }
            },
            "required": ["card"]
        }
    })
}

/// Why a card cannot be closed, whoever asked.
///
/// All three are about the card or the caller rather than about parentage, so
/// none of them is a thing to put to the user — see `may_close`.
#[derive(Debug, PartialEq)]
enum NotYours {
    /// The user parked it.
    Aside,
    /// An agent is part-way through something on it.
    Working,
}

impl NotYours {
    /// The refusal, with its reasoning — `MAX_HOPS`' lesson, which every refusal
    /// in this file follows: an agent told only "no" tries a different phrasing.
    fn say(&self, title: &str) -> String {
        match self {
            NotYours::Aside => format!(
                "the user has set {title:?} aside, which is them saying they mean to come \
                 back to it. That outranks tidying up, so it stays — and it is not \
                 something to ask them about either, since they have already answered it. \
                 Tell them you would have closed it and why."
            ),
            NotYours::Working => format!(
                "{title:?} is mid-turn. Killing an agent part-way through does not stop it \
                 cleanly — it is a file half written and a command that may or may not have \
                 run, and the wall comes back tomorrow asking that card to pick the turn up. \
                 Wait for it to finish, then close it."
            ),
        }
    }
}

/// What this card may do about that one.
#[derive(Debug, PartialEq)]
enum Reach {
    /// It opened it. Off the wall, now.
    Mine,
    /// Somebody else's. Not a refusal any more — a thing to put to the user.
    Theirs,
    /// The caller itself. Also a question, and its own variant for two reasons
    /// that are both about not being `Theirs`.
    ///
    /// The question is worded differently — "this card is asking to be closed"
    /// rather than one card wanting another gone — because the user is being
    /// asked about the card they are probably looking at, and a sentence naming
    /// the same title twice reads as a bug.
    ///
    /// And it must skip the mid-turn refusal, which is the load-bearing half. A
    /// card is inside a turn *by definition* while it is making this call, so a
    /// self-close that fell through to `mid_turn` would be refused every single
    /// time, which is the old behaviour reached by accident instead of on
    /// purpose. Checked ahead of `mid_turn` rather than exempted inside it, so
    /// nothing about turn marking can quietly turn this back off.
    Itself,
    /// No, and here is why.
    No(NotYours),
}

/// Whether this card may take that one off the wall, and on whose say-so.
///
/// Pure, because it is the most consequential decision in the file and the one
/// worth being able to assert.
///
/// **Parentage used to be the authority and is now only the question of who
/// decides.** For the tool's first life a card could close what it opened and
/// nothing else, full stop — which is what made the tool safe enough to exist
/// without a confirmation of its own, since every card it could reach was one it
/// had asked for. What that cost was the case it was written for: on a wall of
/// twenty cards the ones worth tidying are mostly *not* the caller's, and the
/// agent's only move was to say so in prose and hope somebody did it by hand.
/// Tidying that has to be asked for in prose is tidying that does not happen.
///
/// So the bound moved rather than came off. A card may **name** any card, and
/// naming one it did not open parks the call and puts the question to the user
/// (`close_question`, and `.claude/rules/ask.md` for what parking is). Nothing
/// closes on an agent's word alone that did not close on it before, and the
/// thing that used to be a refusal is now a question with a default of no.
///
/// **The order changed with it.** Parentage used to be asked first,
/// deliberately, so a card naming somebody else's card was told only that it was
/// not theirs rather than what that card was doing. That argument was about
/// standing — a caller with no business asking should learn nothing — and it
/// dissolves the moment a card may name any card: the three refusals below are
/// now things every caller is entitled to hear, and hearing "it is mid-turn" is
/// what tells an agent to wait rather than to rephrase. They are asked first for
/// a second reason as well, which is the stronger one: **none of them is a
/// question worth putting to a person.**
///
/// - **Itself is now offered rather than refused**, and this is the one that
///   changed (sink f3f49d9d). It used to be a flat no, on the argument that a
///   card tidying itself away takes its own transcript off the wall while the
///   user may be reading it. That argument is about whose decision it is — and
///   the answer to "whose decision is it" is an `ask_user`, which is exactly
///   what every other card already gets. A user hit this from the other side: they
///   told their card to close itself, the card quoted this refusal at them, they
///   said self-close does work and simply asks, the card deferred to them and
///   tried it, and the tool refused. The documented behaviour was what happened,
///   and the rule was still wrong — "any card I name gets an approval prompt" is
///   a very natural compression of three tiers, and it was wrong for exactly the
///   case people reach for most, since a card asking to be tidied away is the
///   commonest thing a finished card wants.
///
///   It is checked **before** `mid_turn`, which is the load-bearing detail: a
///   caller is inside a turn by definition while making this call, so a
///   self-close falling through to that arm would be refused every time — the
///   old behaviour reached by accident rather than on purpose. Stated as its own
///   arm so nothing about turn marking can quietly turn it back off.
/// - **Set aside outranks tidying up.** It is the one flag on a card that is an
///   explicit human intention rather than a fact about the work: the user saying
///   they are coming back to this. Asking them to approve overriding a decision
///   they have already made is not a question, it is nagging. See `restore.md`.
/// - **Mid-turn is refused rather than warned about or asked about.** An agent
///   part-way through does not stop cleanly, and a person cannot judge from a
///   one-line question whether the turn matters either — so putting it to them
///   would be handing over a decision with the evidence left out. Waiting costs
///   the caller nothing; the alternative costs work.
///
/// `spawner` is out of the same table the one-generation guard reads. `None` —
/// nobody opened it, which is true of every card the user opened themselves — is
/// `Theirs` rather than a refusal, and that is the whole of the change.
fn may_close(
    target: &str,
    spawner: Option<&str>,
    caller: &str,
    aside: bool,
    mid_turn: bool,
) -> Reach {
    /* Ahead of everything, including the caller naming itself: being set aside
       is the user having already answered this question, and that is as true of
       a card asking about itself as of any other. */
    if aside {
        return Reach::No(NotYours::Aside);
    }
    /* Before `mid_turn`, and that is the whole of what makes a self-close
       reachable — see `Reach::Itself`. */
    if target == caller {
        return Reach::Itself;
    }
    if mid_turn {
        return Reach::No(NotYours::Working);
    }
    if spawner == Some(caller) {
        Reach::Mine
    } else {
        Reach::Theirs
    }
}

/// The two things the user may say, and the exact words a click sends.
///
/// `LEAVE_IT` is never matched on to decide anything — everything that is not
/// `CLOSE_IT` leaves the card standing — so it is here to be *offered*, and read
/// back only to tell a deliberate no from a person who typed something else.
const CLOSE_IT: &str = "close it";
const LEAVE_IT: &str = "leave it open";

/// Did the user actually approve this?
///
/// Exact, and nothing looser, because the panel has a free-text field beside the
/// two buttons (`Ask.svelte`) and what comes back is therefore arbitrary prose.
/// Reading a yes out of prose is a thing that works until "yes, but let it
/// finish the commit" or "no, close the other one" — and the failure mode is a
/// card taken off the wall on a sentence that said not to. So the only approval
/// is the button. Every other answer is carried back to the agent **verbatim**
/// (`declined`) rather than flattened into a no: the user has said something,
/// and the agent is the thing standing there able to act on it.
///
/// Case and surrounding space are folded, since neither is a decision.
fn approved(answer: &str) -> bool {
    answer.trim().eq_ignore_ascii_case(CLOSE_IT)
}

/// The most of the caller's reason that reaches the question.
///
/// Short on purpose: this is one line in a panel, not a report. An agent with
/// more to say than this has somewhere better to say it — the reply where it
/// tells the user what it closed.
const MAX_WHY: usize = 300;

/// The question that goes up when a card names a card it did not open.
///
/// Composed here rather than in the front end because the panel draws whatever
/// arrives and knows nothing about cards — `AskOpened::ask` is opaque by design
/// — and it is written to the standard `ask_user` asks are held to. The user is
/// being asked about a card they may not have looked at in hours, so the
/// question carries **which card**, **who wants it gone**, **why**, and **what
/// closing actually does**; the last because "close" reads as destroying
/// something and does not.
fn close_question(target: &str, handle: &str, by: &str, why: Option<&str>) -> Value {
    /* `by == target` is a card offering itself, and the sentence has to change
       rather than name the same title twice — "X wants to close X" reads as a
       bug in the wall. It also says the one thing that is different about
       answering yes here: the transcript on screen is the one that goes. */
    let itself = by == target;
    let said = match why {
        Some(w) => format!(" It says: {w:?}."),
        /* Named as an absence rather than skipped. A question that simply
           carries no reason reads as a card that needed none, and this is the
           one thing on the panel the user cannot go and find out for
           themselves. */
        None => " It gave no reason.".to_string(),
    };
    json!({
        "questions": [{
            "header": "close a card",
            "question": if itself {
                format!(
                    "{target:?} ({handle}) is asking to be closed — it says its work is \
                     done.{said}\n\nThis is the card itself asking, so saying yes takes \
                     the transcript you may be reading off the wall. It does not delete \
                     anything — the transcript stays where Claude Code wrote it and the \
                     session can be adopted back at any time."
                )
            } else {
                format!(
                    "{by:?} wants to close {target:?} ({handle}), which is not a card it \
                     opened.{said}\n\nClosing takes the card off the wall and ends its \
                     process. It does not delete anything — the transcript stays where \
                     Claude Code wrote it and the session can be adopted back at any time."
                )
            },
            "options": [
                {
                    "label": CLOSE_IT,
                    "detail": "Take it off the wall. The transcript is kept."
                },
                {
                    "label": LEAVE_IT,
                    "detail": "It stays. The agent is told you said so."
                }
            ]
        }]
    })
}

/// What the caller is told when the user says no, or says something else.
///
/// The old refusal — "it is not yours to close, so say so and let the user do
/// it" — cannot be reused here even though the outcome is the same, because it
/// is no longer true: the user *was* asked. Telling an agent to go and ask them
/// is how a card ends up asking twice about one card. What it needs instead is
/// the fact, the words, and then to be left alone.
fn declined(title: &str, answer: &str) -> String {
    let said = answer.trim();
    if said.eq_ignore_ascii_case(LEAVE_IT) {
        return format!(
            "the user was asked and said to leave {title:?} open, so it stays. That is an \
             answer rather than this tool refusing you — do not ask again about the same \
             card, and say in your reply that you offered."
        );
    }
    /* Anything else at all, including an approval this function should never
       have been handed: not the button, not closed. Written as a total function
       rather than a partial one because its one caller is a closure on a parked
       request, where a panic takes the request with it and the card waits out
       the client's whole timeout for a reply that is never coming. */
    format!(
        "{title:?} was not closed. The user picked neither option; what they said was: \
         {said:?}. Act on that rather than on the closing — they are talking to you about \
         the card, and it is still on the wall."
    )
}

/// What the caller is told when nobody ever answered.
fn unanswered(title: &str) -> String {
    format!(
        "nobody answered, so {title:?} stays on the wall. Either the question stood for ten \
         minutes or this card was dismissed while it was up. Carry on with your own \
         judgement, and mention that you would have closed it."
    )
}

/// Everything closing a card turns on, read from the store and the supervisor in
/// one pass.
struct Facts {
    id: String,
    title: String,
    spawner: Option<String>,
    aside: bool,
    mid_turn: bool,
    /// How many cards the caller has opened that are still on the wall, this one
    /// included.
    children: i64,
}

/// What the wall says about a card *right now*, addressed however the caller
/// wrote it. `Err` carries the sentence to answer the call with.
///
/// **Every path reads this afresh**, the one resuming ten minutes after the
/// question went up included. A card that was idle when the user was asked can
/// be mid-turn by the time they answer, and an approval is approval to close
/// that card — not a licence over whatever is running under its id now.
fn facts(app: &AppHandle, caller: &str, want: &str) -> Result<Facts, String> {
    let Some(store) = app.try_state::<Store>() else {
        return Err("the store is unavailable".into());
    };
    let Ok(conn) = store.0.lock() else {
        return Err("the store is unavailable".into());
    };

    let rows = match crate::store::roster(&conn, None) {
        Ok(rows) => rows,
        Err(e) => return Err(format!("could not read the wall: {e}")),
    };
    /* `relay::resolve`, so a card is addressed here exactly as it is addressed
       to be sent to — including the refusal of an ambiguous title, which for
       this tool is the difference between closing the right card and closing a
       card with the same name. */
    let target = match crate::relay::resolve(&rows, want) {
        Ok(r) => r,
        Err(e) => return Err(format!("{e}. Nothing was closed.")),
    };
    let id = target.id.clone();
    let title = target.title.clone();

    /* Asked of the supervisor rather than of the row, because a row says what a
       card *is* and only the process map says whether anything is running —
       `relay.rs` reads the same pair for the same reason. */
    let (_, mid_turn) = app.state::<crate::supervisor::Supervisor>().liveness(&id);

    Ok(Facts {
        spawner: crate::store::spawner_of(&conn, &id),
        aside: crate::store::is_aside(&conn, &id),
        mid_turn,
        children: crate::store::live_children_of(&conn, caller),
        id,
        title,
    })
}

/// Take it off the wall and say so.
///
/// There is deliberately no `note` argument on the tool for this. The obvious
/// one — a line on why it was closed, stamped on the row — would be a column
/// nothing on this wall renders, and the description already asks for that
/// sentence in the one place the user will actually read it: the reply where the
/// agent says what it closed. `why` earns its place for the opposite reason. It
/// is read by a person, in the question, at the moment they decide.
fn take_off(app: &AppHandle, caller: &str, f: &Facts, asked: bool) -> String {
    let _ = app.emit(
        "close:asked",
        CloseAsked {
            id: f.id.clone(),
            parent_id: caller.to_string(),
        },
    );

    let title = &f.title;
    let handle = crate::relay::handle_of(&f.id);
    let kept = "Its transcript stays where it is and the session can be adopted back, so this \
                is the card going away rather than the work.";
    if asked {
        /* No count of the caller's own children here, and that is not an
           omission: this card was never one of them, so a number about them
           answers a question nobody asked. What is worth saying instead is whose
           decision it was, since the agent now owes the user a reply and has to
           attribute it correctly. */
        return format!(
            "the user approved it — closing {title:?} ({handle}), a card you did not open. \
             {kept} Say in your reply that you asked and they agreed."
        );
    }
    let mine = f.children - 1;
    format!(
        "closing {title:?} ({handle}) — the wall is taking it off. {kept} You have {mine} of \
         your own still open. Tell the user which one you closed and what it finished."
    )
}

/// What a `close` call turns out to be.
pub(crate) enum Closing {
    /// Answer the tool call with this, now.
    Now(String),
    /// Put this question up and wait. `settle` composes the reply from whatever
    /// comes back, and does the closing if it is a yes.
    Ask {
        question: Value,
        settle: crate::ask::Settle,
    },
}

/// The `close` tool, as far as it can be decided without a person.
///
/// Called from `ask.rs` directly rather than through `handle`, because this is
/// the one tool on that server besides `ask_user` whose answer may not be ready
/// yet. The decision has to be taken *before* the transport commits to answering
/// on the spot, and it must be taken once — two readings of the same wall are
/// two things to keep in step.
pub(crate) fn close(app: &AppHandle, caller: &str, args: &Value) -> Closing {
    let Some(want) = args.get("card").and_then(Value::as_str) else {
        return Closing::Now("no `card` was named, so nothing was closed".into());
    };

    let f = match facts(app, caller, want) {
        Ok(f) => f,
        Err(e) => return Closing::Now(e),
    };

    match may_close(&f.id, f.spawner.as_deref(), caller, f.aside, f.mid_turn) {
        Reach::No(no) => Closing::Now(no.say(&f.title)),
        Reach::Mine => Closing::Now(take_off(app, caller, &f, false)),
        /* Both go to the user, and by the same path deliberately: the only
           difference between offering yourself and offering somebody else's card
           is how the sentence reads, which `close_question` decides from the two
           titles rather than from a second branch here. */
        Reach::Theirs | Reach::Itself => {
            let why = args
                .get("why")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|w| !w.is_empty())
                .map(|w| clip(w, MAX_WHY));
            /* Who is asking, by the name the user knows it by. A handle would be
               correct and unreadable — the whole difficulty of this question is
               that it is about two cards at once, and one of them is the card
               the user is looking at. */
            let by = facts(app, caller, caller)
                .map(|me| me.title)
                .unwrap_or_else(|_| format!("card {}", crate::relay::handle_of(caller)));
            let question = close_question(
                &f.title,
                &crate::relay::handle_of(&f.id),
                &by,
                why.as_deref(),
            );

            let caller = caller.to_string();
            let id = f.id.clone();
            let title = f.title.clone();
            Closing::Ask {
                question,
                settle: Box::new(move |app, answer| {
                    let Some(answer) = answer else {
                        return unanswered(&title);
                    };
                    if !approved(answer) {
                        return declined(&title, answer);
                    }
                    /* Approved — and now read the wall again rather than acting
                       on what it said ten minutes ago. Addressed by id and not
                       by what the caller originally wrote: the card the user was
                       asked about is the card that closes, whatever else has
                       arrived since answering to the same title. */
                    let f = match facts(app, &caller, &id) {
                        Ok(f) => f,
                        Err(_) => {
                            return format!(
                                "the user approved it, but {title:?} is no longer on the \
                                 wall — it went while the question was up. Nothing to do."
                            )
                        }
                    };
                    match may_close(&f.id, f.spawner.as_deref(), &caller, f.aside, f.mid_turn) {
                        /* An approval does not survive the card having started
                           work in the meantime, and that is the whole reason the
                           re-read is here rather than a tidiness. */
                        Reach::No(no) => format!(
                            "the user approved it, but it cannot be closed now: {}",
                            no.say(&f.title)
                        ),
                        _ => take_off(app, &caller, &f, true),
                    }
                }),
            }
        }
    }
}

/// Where a `project` argument says the child stands, decided against the wall's
/// own territories rather than against the filesystem.
///
/// `There` carries an index into the list it was resolved against, so the
/// caller of this keeps the one `ProjectRow` and nothing is looked up twice.
#[derive(Debug, PartialEq)]
enum Standing {
    /// Nothing was named, or what was named is the territory the caller already
    /// stands in — the same answer either way, and it keeps the parent's own
    /// `cwd` rather than the project root, so a card in a worktree opens one
    /// beside it instead of one in the main tree.
    Here,
    There(usize),
    /// Nothing on the wall goes by that.
    Unknown,
    /// More than one does. Refused rather than guessed: two territories can
    /// share a directory name (`C:\dev\nova`, `D:\archive\nova`) since only the
    /// root path is unique, and picking the first would put a card in the wrong
    /// repository with the machine in its hands.
    Ambiguous,
}

/// One path as another path, for comparing. Separators folded and case dropped
/// because this is a Windows-first wall and `C:\atelier\skein` is not a second
/// project from `c:/atelier/skein/`.
fn tidy(p: &str) -> String {
    p.trim().replace('\\', "/").trim_end_matches('/').to_lowercase()
}

fn standing(wall: &[crate::store::ProjectRow], home: &str, asked: &str) -> Standing {
    let asked = asked.trim();
    if asked.is_empty() {
        return Standing::Here;
    }
    /* By root path first, which is unique, so a caller that has the full path
       from `list` never trips the ambiguity below. */
    let found = match wall.iter().position(|p| tidy(&p.root_path) == tidy(asked)) {
        Some(i) => i,
        None => {
            let wanted = asked.to_lowercase();
            let mut hits = wall
                .iter()
                .enumerate()
                .filter(|(_, p)| p.name.trim().to_lowercase() == wanted);
            match (hits.next(), hits.next()) {
                (Some((i, _)), None) => i,
                (Some(_), Some(_)) => return Standing::Ambiguous,
                _ => return Standing::Unknown,
            }
        }
    };
    if wall[found].id == home {
        Standing::Here
    } else {
        Standing::There(found)
    }
}

/// What the wall holds, said back to a caller that named something else. A
/// refusal that lists the alternatives is one an agent can act on; `MAX_HOPS`'
/// lesson, which is the reason every refusal in this file carries its reasoning.
fn offer(wall: &[crate::store::ProjectRow]) -> String {
    if wall.is_empty() {
        return "nothing".into();
    }
    wall.iter()
        .map(|p| format!("{} ({})", p.name, p.root_path))
        .collect::<Vec<_>>()
        .join(", ")
}

/// A directory of Skein's own rather than a project of the user's.
///
/// Chat cards need *an* address and get a folder beside the database
/// (`store::chat_home`), and `#openIn` makes a `project` row of it like any
/// other directory — so it is in the table without ever having been a territory
/// anybody declared. Standing a card that carries
/// `--dangerously-skip-permissions` in Skein's own state directory is not
/// something to make nameable by accident.
fn is_skeins_own(root: &str, data_dir: &std::path::Path) -> bool {
    let base = tidy(&data_dir.to_string_lossy());
    let root = tidy(root);
    root == base || root.starts_with(&format!("{base}/"))
}

fn do_spawn(app: &AppHandle, caller: &str, args: &Value) -> String {
    let Some(prompt) = args.get("prompt").and_then(Value::as_str).map(str::trim) else {
        return "no `prompt` was given, so no card was opened".into();
    };
    if prompt.is_empty() {
        return "the prompt was empty — a card opened with nothing to do is a process and \
                an API turn spent on nothing, so none was opened"
            .into();
    }
    /* Only asked when there is a cap to ask it against, which there is not —
       see `MAX_PROMPT`, and note the shape is the one `MAX_LIVE` and
       `MAX_PER_HOUR` already use: a bound that may not exist rather than a
       sentinel a comparison happens to let through. `clipped` is how many
       characters the wall ate, and it is nonzero on no path today. */
    let (prompt, clipped) = match MAX_PROMPT {
        Some(cap) => clip_brief(prompt, cap),
        None => (prompt.to_string(), 0),
    };
    let title = args
        .get("title")
        .and_then(Value::as_str)
        .map(|t| clip(t.trim(), MAX_TITLE))
        .filter(|t| !t.is_empty());

    let Some(store) = app.try_state::<Store>() else {
        return "the store is unavailable".into();
    };
    let Ok(conn) = store.0.lock() else {
        return "the store is unavailable".into();
    };

    /* Asked of the store, never of the caller — `spawn_conversation`'s rule, and
       the one that keeps a capability from travelling as an argument. */
    let Some(me) = crate::store::roster_one(&conn, caller) else {
        return "this card is not on the wall, so it has nowhere to open another".into();
    };
    if me.kind == "chat" {
        return "this is a chat card: it stands outside the wall's projects and reaches \
                nothing on this machine, so it cannot open a card that would. Tell the \
                user what you would have opened and let them do it."
            .into();
    }
    /* Off, like the two numbers — see `ONE_GENERATION`, which is where the
       argument this used to make is kept. Behind the flag rather than deleted,
       and the query with it: a wall that does not bound generations does not ask
       the store which generation anybody is. */
    if ONE_GENERATION && crate::store::was_spawned(&conn, caller) {
        /* Said with its reasoning, because an agent told only "no" tries a
           different phrasing — `MAX_HOPS`' lesson. */
        return "this card was itself opened by another conversation, and a card opened \
                that way may not open more — a handful of cards each opening a handful is \
                dozens of agents on one prompt, and then hundreds, which is the thing this \
                limit exists to stop. Do the work here, or tell the user what else needs \
                its own card."
            .into();
    }
    /* Both only asked when there is a cap to ask them against, and both off —
       see the note over `MAX_LIVE`. Written as bounds that may not exist rather
       than as comparisons a sentinel happens to slip through, so turning either
       back on is one word and nothing here has to be re-read. The queries stay
       behind the `if`, so a wall with no caps runs no counting either. */
    if let Some(cap) = MAX_LIVE {
        let live = crate::store::live_children_of(&conn, caller);
        if live >= cap {
            return format!(
                "this card already has {live} conversations of its own open on the wall, \
                 which is the limit. Close one of them with `close`, wait for one to \
                 finish, or tell the user which of them should go."
            );
        }
    }
    if let Some(rate) = MAX_PER_HOUR {
        let recent = crate::store::spawns_since(&conn, caller, crate::store::now() - HOUR_MS);
        if recent >= rate {
            return format!(
                "this card has opened {recent} conversations in the last hour, which is the \
                 limit — that is the shape of a fan-out rather than of decomposing a job. \
                 Stop, and tell the user what you were about to open and why."
            );
        }
    }

    /* Read whether or not anything was named, because a refusal has to be able
       to say what would have worked. Skein's own directories are dropped here
       rather than in the query: what makes them not a territory is that nobody
       declared them, which is knowledge about where the database lives and not
       something SQL can see. */
    let wall: Vec<crate::store::ProjectRow> = match crate::store::projects(&conn) {
        Ok(ps) => ps
            .into_iter()
            .filter(|p| !is_skeins_own(&p.root_path, &store.1))
            .collect(),
        Err(e) => return format!("could not read the wall's projects: {e}"),
    };
    let asked = args.get("project").and_then(Value::as_str).unwrap_or("");
    /* Resolved before the id is minted and the spawn recorded, so a misnamed
       project is not written down as a spawn at all — an agent correcting a name
       is not an agent fanning out, and `spawns_since` is what a restored rate
       limit would read. */
    let (cwd, worktree, elsewhere) = match standing(&wall, &me.project_id, asked) {
        /* The parent's tree as well as its territory, and the two are different
           facts for a worktree card: the row's `cwd` is the project root by
           design (`worktree.md`) and the agent stands in the tree for its
           branch. Taking `cwd` alone put the child in the *main* tree — sharing
           a checkout with whatever else is there and unable to see a line of the
           work it was opened to help with, which is the opposite of what
           "open one beside me" means and what this rule claimed to do. */
        Standing::Here => (me.cwd.clone(), me.worktree.clone(), None),
        Standing::There(i) => (wall[i].root_path.clone(), None, Some(wall[i].name.clone())),
        Standing::Unknown => {
            return format!(
                "there is no project called {asked:?} on this wall, so no card was opened. \
                 What is here: {}. Name one of those exactly, or leave `project` out to open \
                 the card where you stand. A directory that is not a territory on the wall \
                 cannot be named at all — if the work belongs somewhere the user has not \
                 opened here, tell them that instead of trying another path.",
                offer(&wall)
            );
        }
        Standing::Ambiguous => {
            return format!(
                "more than one project on this wall is called {asked:?}, so nothing was \
                 picked rather than the wrong one — name the one you mean by its full root \
                 path. What is here: {}.",
                offer(&wall)
            );
        }
    };

    let id = crate::store::uuid_v4();
    /* Recorded before the emit, so the one-generation guard is true of the child
       from the moment it exists rather than from whenever the wall gets round to
       drawing it. `set_mid_turn`'s shape again: bookkeeping about what something
       *is* must not wait for the thing to finish arriving. */
    if let Err(e) = crate::store::record_spawn(&conn, &id, caller) {
        return format!("could not open a card: {e}");
    }
    drop(conn);

    let _ = app.emit(
        "spawn:asked",
        SpawnAsked {
            id: id.clone(),
            parent_id: caller.to_string(),
            cwd: cwd.clone(),
            worktree: worktree.clone(),
            prompt,
            title: title.clone(),
        },
    );

    let handle = crate::relay::handle_of(&id);
    let called = match &title {
        Some(t) => format!(" It is called {t:?} until it names itself."),
        None => " It will name itself from its first turn.".into(),
    };
    /* Said out loud, because it is the one thing about a card opened here that
       the caller cannot see and has to act on: two agents in one checkout is
       how a morning's work ends up under somebody else's commit message. The
       wall has no other way to tell either of them. */
    let sharing = match &worktree {
        Some(name) => format!(
            " It works in the same tree as you, on {name}, so you are both editing one \
             checkout — say what each of you owns, and stage exact paths rather than `-A`."
        ),
        None => String::new(),
    };
    /* The other end of the marker in `clip_brief`, and the end that can do
       something about it. Telling only the child costs a turn each way — it has
       to notice, work out who to ask, and ask — where the parent still has the
       whole brief in front of it and can `send` the remainder in the next
       breath. Sink `f468f017` had neither end told, which is why it was found by
       a sentence stopping mid-word.

       Empty on every path today, per `MAX_PROMPT`. */
    let ate = match clipped {
        0 => String::new(),
        n => format!(
            " **The wall could not carry your whole brief**: {n} characters did not go, and \
             the card has been told so. Send it the rest with `send` before it starts."
        ),
    };
    match elsewhere {
        None => format!(
            "opening a card in {cwd} — its handle is {handle}. It has the brief you wrote and \
             nothing else of yours. Tell the user you have opened it and what for. You can \
             `send` to it or `recall` it by that handle; it will not appear in `list` until \
             its process is up, which takes a moment.{called}{sharing}{ate}"
        ),
        /* Said differently on purpose. A card in another repository is the one
           case where "it has the brief and nothing else" costs something real:
           it cannot read the file you were looking at, so anything it needed
           from here was either in the brief or is gone. And it is outside the
           caller's project, so the default `list` will not show it — being told
           that here saves a round of looking for a card that is standing right
           where it was asked to. */
        Some(name) => format!(
            "opening a card in the {name} project, at {cwd} — its handle is {handle}. It has \
             the brief you wrote and nothing else of yours, and it stands in a different \
             repository from this one, so whatever it needs to know about *this* one had to \
             be in the brief. Tell the user you have opened it, where, and what for. You can \
             `send` to it or `recall` it by that handle; it will not appear in `list` until \
             its process is up, and then only under `scope: \"skein\"`, since it is not in \
             your project.{called}{ate}"
        ),
    }
}

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    s.chars().take(max).collect()
}

/// How far back from a hard cut it is worth looking for somewhere to stop.
///
/// A boundary rule with no floor is a rule that can throw away most of a brief
/// to find a blank line: a five-thousand-character paragraph with one `\n\n` at
/// character 40 would clip to forty characters, which is worse than the mid-word
/// cut it was supposed to improve on. So each rule below is tried in turn and
/// taken only if it lands in the last quarter of the budget; otherwise the next,
/// weaker one gets a go, and a brief with no boundaries in it at all is cut
/// where it was always going to be cut.
const BOUNDARY_FLOOR: f64 = 0.75;

/// What a card is told when the wall could not carry the whole brief.
///
/// Two things, and the second is the one that was missing. Cutting at a
/// paragraph or a list item stops a card reading half a word — but a brief cut
/// at a *paragraph* boundary reads as complete, which is the trap: the card that
/// hit this (sink `f468f017`) only noticed because the sentence stopped
/// mid-word, and a tidier cut would have made the same brief look finished. So
/// the marker is not decoration on the boundary rule, it is the half that
/// actually tells the truth, and the boundary rule exists so that the marker is
/// the only thing that has to.
///
/// It names a next move rather than only a fact. A card that knows it is missing
/// four hundred characters and does not know who has them is a card that
/// infers — and it now does know: `append_prompt` names the parent to every
/// spawned card, so "ask the card that opened you" is one `send` away rather
/// than a round of `list` and a guess. The two items were filed separately and
/// this sentence is where they meet.
///
/// **No live caller**, per `MAX_PROMPT`.
fn clip_brief(s: &str, max: usize) -> (String, usize) {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= max {
        return (s.to_string(), 0);
    }

    let head: String = chars[..max].iter().collect();
    let floor = (max as f64 * BOUNDARY_FLOOR) as usize;

    /* Strongest first. A paragraph break is a whole thought; a line break is a
       list item, which is the shape the brief that found this bug was in; a
       space is merely not mid-word. `rfind` answers in bytes, and every
       needle here is ASCII, so the byte index is a char boundary — but the
       *count* that goes in the marker has to be in characters, since that is
       what `max` is measured in and what the caller will compare against. */
    let cut = ["\n\n", "\n", " "]
        .iter()
        .find_map(|sep| {
            let at = head.rfind(sep)?;
            let kept = head[..at].chars().count();
            (kept >= floor).then_some(kept)
        })
        .unwrap_or(max);

    let kept: String = chars[..cut].iter().collect();
    let omitted = chars.len() - cut;
    let text = format!(
        "{}\n\n[brief truncated by the wall — {omitted} of {} characters did not arrive. \
         What you have above may read as complete and is not. Ask the card that opened you \
         for the rest with `{}send` before acting on it.]",
        kept.trim_end(),
        chars.len(),
        crate::supervisor::MCP_PREFIX,
    );
    (text, omitted)
}

/// The roster chain's half of this server's two tools, which is one of them.
///
/// `close` is deliberately absent and is routed by `ask.rs` before the chain is
/// reached, because it may have to park — see `close`. Routing it here as well
/// would be a second path to the same decision and the one that drifts is the
/// one nobody is looking at, so there is exactly one; `the_two_ends_are_routed`
/// asserts that the tool the server advertises is the tool that dispatch names.
pub fn handle(app: &AppHandle, conversation_id: &str, tool: &str, args: &Value) -> Option<String> {
    match tool {
        SPAWN_TOOL => Some(do_spawn(app, conversation_id, args)),
        _ => None,
    }
}

/// The whole wall's parentage, for the roots to be drawn from — `[child,
/// parent]` per pair, both ends still open.
///
/// Asked once at launch and then never again: a spawn *emits*, so the wall
/// learns about a new root from `spawn:asked` rather than by asking. That is the
/// same bargain every other table on this server strikes with the front end, and
/// the reason `Lineage.svelte` has no poll in it.
#[tauri::command]
pub fn lineage(app: AppHandle) -> Result<Vec<[String; 2]>, String> {
    let store = app.state::<Store>();
    let conn = store.0.lock().map_err(|_| "the store is unavailable")?;
    Ok(crate::store::lineage(&conn)?
        .into_iter()
        .map(|(child, parent)| [child, parent])
        .collect())
}

/// Who opened this card, for the wall to draw. `None` for one you opened
/// yourself, which is nearly all of them.
#[tauri::command]
pub fn spawned_by(app: AppHandle, id: String) -> Result<Option<String>, String> {
    let store = app.state::<Store>();
    let conn = store.0.lock().map_err(|_| "the store is unavailable")?;
    Ok(crate::store::spawner_of(&conn, &id))
}

/* ── telling a parent its children have stopped ─────────────────────────────
 *
 * A card that opened nine cards had one way to find out whether they had
 * finished: call `list`, read the tiers, guess. Measured on 2026-08-27 — about
 * a dozen calls over an afternoon, and **twice it acted on a reading that had
 * already moved**, once relaying a wrong conclusion to eight cards. That is a
 * turn each way and a wrong instruction at the end of it.
 *
 * Both halves of the answer were already here and had never been joined.
 * Parentage is a table (`spawned`), and settling is an **event**: `result`
 * closes a turn, `supervisor::persist_turn` is the one place both boundaries
 * already go through, and `relay::turn_closed` is already hung off it. So
 * nothing here polls for the thing it cares about — `CLAUDE.md`'s standing rule
 * exactly, *look for an event that already exists near it and fold that*.
 *
 * ### "at rest" is not "finished", and that is the whole difficulty
 *
 * A card goes to rest between **every** pair of turns. A notice per transition
 * would cost the parent a turn every time a child paused for breath, which is
 * the spiral `relay.rs` guards against arriving through a door it does not
 * watch. What a parent wants is *stopped, and not about to start again*, and
 * nothing on the wire says that — so what is folded is the event and what is
 * left over is bounded, in four ways, each aimed at a different failure:
 *
 * 1. **A grace.** A rest only becomes tellable after `SETTLE_GRACE_MS` of
 *    silence, and any turn opening inside it cancels the whole thing
 *    (`stirring`). A tool call does not close a turn, so a child grinding
 *    through a build is never at rest to begin with; what this actually has to
 *    outlast is the gap before a queued relay, a `wake_me`, or the
 *    `<task-notification>` the CLI injects when a background job lands —
 *    measured at a ten-second median in `supervisor::turn_mark`'s note.
 * 2. **Coalescing.** Due settles are grouped by parent and go as *one* message.
 *    Eleven children finishing within a minute of each other is the case this
 *    was built for, and eleven messages would be eleven turns.
 * 3. **A floor.** `SETTLE_APART_MS` between two notices to one parent. Anything
 *    due inside it does not go and is not lost — its due time is pushed to the
 *    end of the floor, where it joins the next batch. Five minutes is the cap
 *    said as an interval rather than as a count, and it lands on twelve an hour,
 *    which is `later::MAX_SERVED` arrived at from the other direction.
 * 4. **Verified in the moment before it is sent.** The batch is re-read against
 *    the live wall — a child that started again inside the grace, or was closed,
 *    drops out. Sending a reading that has moved is the exact failure this
 *    exists to remove, and it would be an odd thing to reproduce.
 *
 * ### What it deliberately does not do
 *
 * - **It does not rouse.** A dormant parent is not written to and nothing is
 *   queued for it; the notice is dropped. `later.rs` queues a wake because
 *   somebody *asked* for one, and the same argument runs the other way here:
 *   nobody asked for this, its whole value is being timely, and a card that has
 *   stopped should not come back tomorrow to be told about work that finished
 *   today. It calls `list` when it wakes, as it would have anyway.
 * - **It keeps nothing on disk.** A pending settle is about a card that is
 *   running *now*; across a restart there is no parent to tell and no child
 *   still going, so a table would only be a way to deliver stale news. Hence a
 *   plain map rather than a row, and no migration.
 * - **It asks for nothing back.** The envelope says so in words, because a
 *   parent that answers a notice has spent the turn this was built to save.
 */

/// How long a child must have been quiet before it counts as stopped.
///
/// Two minutes. The cost of being late is latency the parent was paying anyway;
/// the cost of being early is a wrong conclusion relayed onward, which is the
/// incident. So it is set on the generous side of what the gaps above need.
const SETTLE_GRACE_MS: i64 = 2 * 60 * 1_000;

/// The least time between two notices to one parent. See the note above.
const SETTLE_APART_MS: i64 = 5 * 60 * 1_000;

/// A rest waiting to see whether it is a stop.
struct Settling {
    parent_id: String,
    /// When it becomes tellable — pushed out by the floor rather than dropped.
    due_at: i64,
}

#[derive(Default)]
struct Brood {
    /// child id → the rest it is currently sitting in.
    pending: std::collections::HashMap<String, Settling>,
    /// parent id → when it was last told anything.
    told_at: std::collections::HashMap<String, i64>,
}

static BROOD: std::sync::OnceLock<std::sync::Mutex<Brood>> = std::sync::OnceLock::new();

fn brood() -> &'static std::sync::Mutex<Brood> {
    BROOD.get_or_init(Default::default)
}

/// A turn has opened on a card, so it has not stopped after all.
///
/// Called on the *transition* only, from `supervisor::persist_turn` — which is
/// the reason this is not written to watch the stream itself. `stream_event`
/// arrives thousands of times a turn and every one of them says "open".
pub fn stirring(id: &str) {
    if let Ok(mut b) = brood().lock() {
        b.pending.remove(id);
    }
}

/// A turn has closed on a card. If another card opened it, start the grace.
///
/// The parent is asked of the store rather than remembered, for
/// `guidance::for_conversation`'s reason one file over: a thing carried in
/// memory is a thing every future path has to remember to carry, and this one
/// would be wrong for exactly the cards restored at launch.
pub fn settling(app: &AppHandle, id: &str) {
    let Some(store) = app.try_state::<Store>() else {
        return;
    };
    let parent_id = {
        let Ok(conn) = store.0.lock() else { return };
        crate::store::spawner_of(&conn, id)
    };
    let Some(parent_id) = parent_id else { return };
    if let Ok(mut b) = brood().lock() {
        b.pending.insert(
            id.to_string(),
            Settling { parent_id, due_at: crate::store::now() + SETTLE_GRACE_MS },
        );
    }
}

/// Everything that has gone quiet long enough, delivered.
///
/// Called from `later::spawn_waker`'s loop rather than from a thread of its own,
/// and that is the point: **this adds no poller.** The event is folded in
/// `settling`; the only thing left needing a clock is a moment *arriving*, which
/// is `later.rs`'s own justification for the tick that already runs — "a moment
/// arriving is not something that happens to anything" — at a granularity of
/// five seconds against delays measured in minutes. A second thread doing the
/// identical thing at the identical interval would be a second thing to get
/// wrong, for nothing.
pub fn sweep(app: &AppHandle) {
    let now = crate::store::now();

    /* Taken out of the map as they are read, before anything is delivered, for
       `later::serve_due`'s reason: a notice lost is a parent that goes back to
       calling `list`, where one delivered twice is two turns spent on the same
       nothing. Wrong in the cheap direction on purpose. */
    let mut by_parent: std::collections::HashMap<String, Vec<String>> = Default::default();
    {
        let Ok(mut b) = brood().lock() else { return };
        let due: Vec<String> = b
            .pending
            .iter()
            .filter(|(_, s)| s.due_at <= now)
            .map(|(id, _)| id.clone())
            .collect();
        for child in due {
            let Some(parent) = b.pending.get(&child).map(|s| s.parent_id.clone()) else {
                continue;
            };
            let last = b.told_at.get(&parent).copied().unwrap_or(i64::MIN);
            /* The floor, and it holds rather than drops — a child that settled
               four minutes after its sibling is still news, it is just news that
               travels with whatever else has happened by then. */
            if now.saturating_sub(last) < SETTLE_APART_MS {
                if let Some(s) = b.pending.get_mut(&child) {
                    s.due_at = last.saturating_add(SETTLE_APART_MS);
                }
                continue;
            }
            b.pending.remove(&child);
            by_parent.entry(parent).or_default().push(child);
        }
    }

    for (parent, children) in by_parent {
        let Some(text) = notice(app, &parent, &children) else {
            continue;
        };
        /* A dormant parent gets nothing and nothing is kept — see the note
           above. The entries are already out of the map, which is what makes
           that true rather than merely intended. */
        if crate::supervisor::deliver(app, &parent, &text).is_ok() {
            if let Ok(mut b) = brood().lock() {
                b.told_at.insert(parent, now);
            }
        }
    }
}

/// What one parent is told, or `None` if by now there is nothing to say.
///
/// This is the verification pass, and it runs against the wall as it is *now*
/// rather than as it was when the grace was armed.
fn notice(app: &AppHandle, parent_id: &str, just_settled: &[String]) -> Option<String> {
    let store = app.try_state::<Store>()?;
    let sup = app.state::<crate::supervisor::Supervisor>();

    /* `lineage` is the pairs with **both** ends still open, so a parent that has
       itself been closed answers with nothing and a child closed inside the
       grace drops out — one query doing the work of three guards. Filtering
       here rather than adding a `children_of` to `store.rs`: the table is small,
       this runs at most once per parent per five minutes, and it is one fewer
       shared file to be inside. */
    let (kin, titles) = {
        let conn = store.0.lock().ok()?;
        let kin: Vec<String> = crate::store::lineage(&conn)
            .unwrap_or_default()
            .into_iter()
            .filter(|(_, p)| p == parent_id)
            .map(|(c, _)| c)
            .collect();
        let titles: std::collections::HashMap<String, String> = kin
            .iter()
            .filter_map(|c| crate::store::roster_one(&conn, c).map(|r| (c.clone(), r.title)))
            .collect();
        (kin, titles)
    };

    let mut settled: Vec<String> = Vec::new();
    for c in just_settled {
        if !kin.contains(c) {
            continue; // closed, or its parent was, since the grace was armed
        }
        if sup.liveness(c).1 {
            continue; // speaking again in the moment before this went out
        }
        settled.push(named(c, titles.get(c)));
    }
    if settled.is_empty() {
        return None;
    }

    /* The number the parent was really calling `list` for. Answering it here is
       what lets one notice end the question rather than start a round of them. */
    let busy = kin.iter().filter(|c| sup.liveness(c).1).count();
    Some(envelope(&settled, busy, kin.len()))
}

/// A card as a notice names it: its title, and the handle that addresses it.
///
/// Both, because they answer different questions — the title is what the parent
/// recognises and the handle is what `recall`, `send` and `close` take.
fn named(id: &str, title: Option<&String>) -> String {
    let handle = crate::relay::handle_of(id);
    match title.map(|t| t.trim()).filter(|t| !t.is_empty()) {
        Some(t) => format!("\"{t}\" ({handle})"),
        None => format!("an untitled card ({handle})"),
    }
}

/// The message itself.
///
/// Pure, so both ends of the round trip can be asserted — the same bargain
/// `relay::envelope` and `later::envelope` strike, and the reason the front end
/// can recognise this off the words alone.
fn envelope(settled: &[String], busy: usize, kin: usize) -> String {
    let mark = crate::relay::RELAY_MARK;
    let what = if settled.len() == 1 {
        format!("A card you opened has stopped: {}.", settled[0])
    } else {
        format!("{} cards you opened have stopped: {}.", settled.len(), list(settled))
    };
    /* Said as a fraction rather than as a count, because "3 still working" and
       "3 of 9 still working" are different amounts of knowing and the second is
       the one that ends the question. */
    let rest = match busy {
        0 if kin == settled.len() => " Nothing else you opened is working.".to_string(),
        0 => " None of your other cards is working either.".to_string(),
        1 => format!(" 1 of your {kin} is still working."),
        n => format!(" {n} of your {kin} are still working."),
    };
    format!(
        "{mark} from the wall —\n\n{what}{rest}\n\n\
         (This came from the wall rather than from anybody, so nobody is waiting on a \
         reply and there is nothing to acknowledge. It is sent so you do not have to keep \
         calling `list`. **Quiet is evidence, not a report**: a card is silent here for \
         {} minutes, which is not the same as having finished — `recall` what it actually \
         said before you conclude anything from it or pass it on, and `close` it once it \
         has plainly reported. If there is nothing to do about this, do nothing.)",
        SETTLE_GRACE_MS / 60_000
    )
}

/// Names in a line, with an `and` where a reader expects one.
fn list(items: &[String]) -> String {
    match items {
        [] => String::new(),
        [one] => one.clone(),
        [a, b] => format!("{a} and {b}"),
        [rest @ .., last] => format!("{}, and {last}", rest.join(", ")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The three things an agent has to understand before calling this, all of
    /// which are in the description because there is nowhere else to put them.
    #[test]
    fn the_tool_draws_the_line_against_a_subagent() {
        let s = spawn_schema();
        assert_eq!(s["name"], SPAWN_TOOL);
        let d = s["description"].as_str().unwrap();
        /* Without this an agent reaches for it where `Agent` was wanted, and
           leaves cards on the wall for work it needed the answer to. */
        assert!(d.contains("not a subagent"), "{d}");
        assert!(d.contains("`Agent`"), "{d}");
        /* Without this it opens one without saying so, which is the one thing
           that must not be quiet — it spends the user's money. */
        assert!(d.contains("Tell them"), "{d}");
        /* And the bound it cannot argue around — which is no longer "here" but
           "somewhere already on this wall". An agent that does not read that as
           a bound reads `project` as a path argument and writes one. */
        assert!(d.contains("cannot point it at an arbitrary path"), "{d}");
        assert!(d.contains("already on this wall"), "{d}");
    }

    /// Naming another territory is the point of the argument, and naming the one
    /// you are in is not an error — it is the default said out loud.
    #[test]
    fn the_project_field_offers_the_wall_and_refuses_a_path() {
        let d = spawn_schema()["inputSchema"]["properties"]["project"]["description"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(d.contains("already opened on this wall"), "{d}");
        assert!(d.contains("arbitrary directory is refused"), "{d}");
        /* Omitting it has to read as the normal case, or every spawn arrives
           carrying a project it did not need to name. */
        assert!(d.contains("Omit it and the card stands where you do"), "{d}");
    }

    /// The brief says what the child gets, so it is the one place that can stop
    /// a coordinator writing the same protocol into eleven of them.
    ///
    /// Measured, 2026-08-27: eleven briefs carrying ~800 identical tokens each,
    /// three of whose paragraphs did not exist when the first four were written
    /// — so the early cards never got them and two hit exactly the failures the
    /// later text warns about. That is the failure this paragraph is aimed at,
    /// and it is *drift* rather than waste: N copies of a rule have N ages.
    #[test]
    fn the_brief_is_not_where_a_repeated_rule_goes() {
        let d = spawn_schema()["inputSchema"]["properties"]["prompt"]["description"]
            .as_str()
            .unwrap()
            .to_string();
        /* The sentence that was untrue: a child shares the repository *and*
           whatever the territory is telling every card that starts in it. An
           agent that believes the brief is the only channel has no reason to
           look for the other one. */
        assert!(d.contains("standing instructions"), "{d}");
        /* And the honest limit, which is the half a coordinator actually needs:
           `guidance.md`'s "a card already running does not hear an edit" is
           precisely what bit here — a rule learned at two o'clock could not
           reach the cards opened at eleven. Without this an agent asks for an
           instruction and then assumes its running children have it. */
        assert!(d.contains("already running does not hear"), "{d}");
    }

    /// The authority, and what is left of it. Written as a table because the
    /// interesting cases are the ones that are *nearly* allowed.
    ///
    /// Parentage decides who says yes, not whether the answer can be yes at all
    /// — so the row that used to be the whole point of this test (a card naming
    /// a card it did not open) is now `Theirs`, which is a question rather than
    /// a refusal.
    #[test]
    fn a_card_closes_its_own_and_offers_the_rest() {
        let me = "parent";
        let it = "child";
        assert_eq!(may_close(it, Some(me), me, false, false), Reach::Mine);

        /* A sibling — opened by the same card, but not by this one. */
        assert_eq!(may_close(it, Some("other"), me, false, false), Reach::Theirs);
        /* The card that opened *me*. Parentage runs one way. */
        assert_eq!(
            may_close("grandparent", Some("great"), me, false, false),
            Reach::Theirs
        );
        /* And every card the user opened, which is nearly all of them and is
           the case the whole change is for. */
        assert_eq!(may_close(it, None, me, false, false), Reach::Theirs);
        assert_eq!(may_close(it, None, "anyone", false, false), Reach::Theirs);
    }

    /// A card may offer itself, and the ordering is what makes that reachable.
    ///
    /// This used to assert the opposite — a flat refusal — and the reason it
    /// changed is in `may_close`'s own doc: a user told their card to close
    /// itself, the card quoted the refusal at them, and they were right that it
    /// should simply ask (sink f3f49d9d).
    ///
    /// **`mid_turn: true` is the case worth reading.** A caller is inside a turn
    /// by definition while it is making this call, so if the self check sat below
    /// `mid_turn` every self-close would be refused — the old behaviour reached
    /// by accident, passing every other test, and indistinguishable from this
    /// feature not existing.
    #[test]
    fn a_card_may_offer_itself_even_though_it_is_mid_turn() {
        let me = "parent";
        assert_eq!(may_close(me, Some("whoever"), me, false, false), Reach::Itself);
        assert_eq!(may_close(me, Some(me), me, false, false), Reach::Itself);
        /* The one that would regress silently. */
        assert_eq!(may_close(me, None, me, false, true), Reach::Itself);
    }

    /// And being set aside still outranks it, which is why that check is above
    /// the self check rather than below it: the user has already answered this
    /// question, and that is as true of a card asking about itself as of any
    /// other.
    #[test]
    fn a_card_set_aside_cannot_offer_itself_either() {
        let me = "parent";
        assert_eq!(may_close(me, None, me, true, false), Reach::No(NotYours::Aside));
        assert_eq!(may_close(me, None, me, true, true), Reach::No(NotYours::Aside));
    }

    /// Both of these are refusals rather than questions, whoever is named.
    /// Putting either to a person would be asking them to override a decision
    /// they have already made, or to judge a turn they cannot see.
    ///
    /// One exception, and it is above rather than a hole in this: `mid_turn` does
    /// not refuse the *caller's own* card, because a caller is always mid-turn.
    /// `a_card_may_offer_itself_even_though_it_is_mid_turn` is that case;
    /// `aside` has no exception and holds for the caller too.
    #[test]
    fn aside_and_mid_turn_are_refused_whoever_asks() {
        let me = "parent";
        for spawner in [Some(me), Some("other"), None] {
            assert_eq!(
                may_close("card", spawner, me, true, false),
                Reach::No(NotYours::Aside)
            );
            assert_eq!(
                may_close("card", spawner, me, false, true),
                Reach::No(NotYours::Working)
            );
        }
    }

    /// The question names the card twice or it names it once, and which one
    /// depends on whether a card is offering itself.
    ///
    /// Worth asserting rather than reading, because the failure is a sentence
    /// like `"release notes" wants to close "release notes", which is not a card
    /// it opened` — true of every clause and unreadable as a question about the
    /// wall. The self wording also has to say the one thing that is genuinely
    /// different: the transcript on screen is the one that goes.
    #[test]
    fn a_card_offering_itself_is_asked_about_differently() {
        let mine = close_question("release notes", "ab12cd34", "release notes", Some("all done"));
        let said = mine["questions"][0]["question"].as_str().expect("a question");
        assert!(said.contains("is asking to be closed"), "{said}");
        assert!(said.contains("the card itself asking"), "{said}");
        assert!(said.contains("you may be reading"), "{said}");
        assert!(!said.contains("not a card it"), "the other wording leaked in: {said}");
        assert!(said.contains("all done"), "the reason is still carried: {said}");

        let theirs = close_question("release notes", "ab12cd34", "the gate watcher", None);
        let said = theirs["questions"][0]["question"].as_str().expect("a question");
        assert!(said.contains("wants to close"), "{said}");
        assert!(said.contains("not a card it"), "{said}");
        assert!(said.contains("gave no reason"), "{said}");

        /* Both offer the same two answers — the wording changes, the decision
           does not. */
        for q in [&mine, &theirs] {
            let opts = q["questions"][0]["options"].as_array().expect("options");
            assert_eq!(opts.len(), 2);
            assert_eq!(opts[0]["label"], CLOSE_IT);
            assert_eq!(opts[1]["label"], LEAVE_IT);
        }
    }

    /// The order, which flipped with the authority. Parentage used to be asked
    /// first so that a stranger learned nothing about the card it named; now
    /// every caller may name any card, so the useful answer is the specific one
    /// — "wait for it" rather than "not yours", which is the difference between
    /// an agent that waits and one that rephrases.
    #[test]
    fn a_card_that_cannot_go_says_why_rather_than_who() {
        let no = may_close("card", Some("other"), "parent", false, true);
        assert_eq!(no, Reach::No(NotYours::Working));
        let Reach::No(no) = no else { unreachable!() };
        let said = no.say("somebody else's work");
        assert!(said.contains("mid-turn"), "{said}");
        assert!(said.contains("Wait"), "{said}");
    }

    /// Every refusal carries its reasoning and a way forward, per `MAX_HOPS`.
    #[test]
    fn every_refusal_says_what_to_do_instead() {
        for no in [NotYours::Aside, NotYours::Working] {
            let said = no.say("the card");
            assert!(said.contains("the card"), "{said}");
            /* Either hand it back to the user, or wait — never a bare no. */
            assert!(
                said.contains("user")
                    || said.contains("them")
                    || said.contains("Wait"),
                "a refusal with no way forward gets rephrased and retried: {said}"
            );
        }
        /* And the two that are refusals rather than questions have to say so,
           or an agent reads them as the ask having gone against it and reports
           to the user that they declined something they were never shown. */
        assert!(NotYours::Aside.say("x").contains("already answered it"));
    }

    /// Only the button is a yes.
    ///
    /// The panel has a free-text field beside the options, so the answer is
    /// arbitrary prose — and a card must not come off the wall on a sentence
    /// that said not to.
    #[test]
    fn nothing_but_the_button_approves() {
        assert!(approved(CLOSE_IT));
        /* Case and space are folded; neither is a decision. */
        assert!(approved("  Close It  "));
        assert!(approved("CLOSE IT"));

        assert!(!approved(LEAVE_IT));
        assert!(!approved(""));
        /* The sentences that would have been read as approval by anything
           looking for a yes inside prose. Each of these means something the
           agent has to act on, and none of them means close it. */
        assert!(!approved("yes, but let it finish the commit first"));
        assert!(!approved("yes"));
        assert!(!approved("close it after the tests pass"));
        assert!(!approved("no, close it? no"));
        assert!(!approved("don't close it"));
    }

    /// What the user is asked has to stand on its own — they may not have looked
    /// at this card in hours, and the panel is all they get.
    #[test]
    fn the_question_carries_both_cards_the_reason_and_the_stakes() {
        let q = close_question("sink: the push chip", "7081456c", "tidying up", Some("it shipped"));
        let text = q["questions"][0]["question"].as_str().unwrap();
        /* Which card, and by an address they can go and look at. */
        assert!(text.contains("sink: the push chip"), "{text}");
        assert!(text.contains("7081456c"), "{text}");
        /* Who wants it gone — one of these two cards is the one they are
           looking at, and the question is unreadable without saying which. */
        assert!(text.contains("tidying up"), "{text}");
        /* Why. */
        assert!(text.contains("it shipped"), "{text}");
        /* And that this is not destroying anything, because "close" reads as
           though it is and a user who thinks so answers no to all of them. */
        assert!(text.contains("does not delete"), "{text}");
        assert!(text.contains("adopted back"), "{text}");

        let opts = q["questions"][0]["options"].as_array().unwrap();
        assert_eq!(opts.len(), 2);
        assert_eq!(opts[0]["label"], CLOSE_IT);
        assert_eq!(opts[1]["label"], LEAVE_IT);
    }

    /// A missing reason is drawn as an absence rather than left out. A question
    /// carrying no reason at all reads as a card that needed none.
    #[test]
    fn a_question_with_no_reason_says_so() {
        let q = close_question("a card", "abcd1234", "somebody", None);
        let text = q["questions"][0]["question"].as_str().unwrap();
        assert!(text.contains("gave no reason"), "{text}");
    }

    /// `normalizeAsk` is the front end's, and this payload has to survive it —
    /// one question, two options, both with a label. The shape is asserted here
    /// because nothing in Rust reads it back and a typo would reach the user as
    /// a panel with nothing to click.
    #[test]
    fn the_question_is_shaped_the_way_the_panel_reads_one() {
        let q = close_question("a card", "abcd1234", "somebody", None);
        let qs = q["questions"].as_array().expect("questions is a list");
        assert_eq!(qs.len(), 1);
        assert!(qs[0]["header"].as_str().is_some_and(|h| !h.is_empty()));
        assert!(qs[0]["question"].as_str().is_some_and(|t| !t.is_empty()));
        for o in qs[0]["options"].as_array().unwrap() {
            assert!(o["label"].as_str().is_some_and(|l| !l.trim().is_empty()));
            assert!(o["detail"].as_str().is_some_and(|d| !d.trim().is_empty()));
        }
    }

    /// A no is a decision the user made, and the agent has to be able to tell it
    /// from this tool refusing — otherwise it goes and asks them in prose for
    /// the thing it has just been told about.
    #[test]
    fn a_decline_reads_as_an_answer_rather_than_a_refusal() {
        let said = declined("a card", LEAVE_IT);
        assert!(said.contains("a card"), "{said}");
        assert!(said.contains("was asked"), "{said}");
        assert!(said.contains("do not ask again"), "{said}");
    }

    /// Anything that is not one of the two buttons is carried back word for
    /// word. The user has said something, and the agent is the thing standing
    /// there able to act on it — flattening it to "declined" throws away the
    /// only part that was worth having.
    #[test]
    fn what_the_user_typed_reaches_the_agent() {
        let said = declined("a card", "close the other one, this one is still building");
        assert!(said.contains("close the other one, this one is still building"), "{said}");
        assert!(said.contains("still on the wall"), "{said}");
        /* Including — defensively — an approval, which this function's caller
           never hands it. It is total rather than partial because that caller is
           a closure on a parked HTTP request, where a panic loses the reply and
           the card waits out the client's whole timeout for nothing. */
        assert!(!declined("a card", CLOSE_IT).is_empty());
    }

    /// Nobody answered is its own outcome and not a no: the agent should say it
    /// would have closed the card, rather than reporting that the user declined.
    #[test]
    fn an_unanswered_question_is_not_a_refusal() {
        let said = unanswered("a card");
        assert!(said.contains("a card"), "{said}");
        assert!(said.contains("nobody answered"), "{said}");
        assert!(said.contains("own judgement"), "{said}");
    }

    /// The three things an agent has to understand before calling this, and the
    /// one it has to be told to do afterwards.
    #[test]
    fn closing_says_what_it_is_and_what_it_is_not() {
        let s = close_schema();
        assert_eq!(s["name"], CLOSE_TOOL);
        let d = s["description"].as_str().unwrap();
        /* The new shape, and it has to be legible in both halves: it may name
           any card, *and* naming one that is not its own costs a question. An
           agent that reads only the first half tidies a wall it has not read. */
        assert!(d.contains("closes on your say-so"), "{d}");
        assert!(d.contains("asks the user first"), "{d}");
        assert!(d.contains("parks your own"), "{d}");
        /* Without this it either avoids a tool it should use, believing it
           destroys work, or uses it carelessly, believing it is free. */
        assert!(d.contains("not deleting"), "{d}");
        assert!(d.contains("adopted back"), "{d}");
        /* And the wall must not lose a card silently — the same sentence
           `spawn` owes for the same reason, one direction over. Now owed for
           the refusal too, since an offer the user declined is also a thing
           that happened to their wall. */
        assert!(d.contains("Say what you closed"), "{d}");
        assert!(d.contains("said no"), "{d}");
        /* The three that are refused outright have to be named, or the agent
           learns them one failed call at a time. */
        assert!(d.contains("mid-turn"), "{d}");
        assert!(d.contains("set aside"), "{d}");
    }

    /// The reason is the whole of what the user has to go on, so the field has
    /// to say so — an optional argument described as optional is one a model
    /// leaves out.
    #[test]
    fn the_reason_field_says_who_reads_it() {
        let d = close_schema()["inputSchema"]["properties"]["why"]["description"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(d.contains("may not have looked at"), "{d}");
        assert!(d.contains("what it finished"), "{d}");
    }

    /// `spawn` and `close` are two ends of one thing, and they are routed in two
    /// different places — `close` may have to park, so `ask.rs` reaches it
    /// before the roster chain and `handle` deliberately does not know it. A
    /// tool the server lists and nobody routes is a call that comes back as "no
    /// such tool", so the names are asserted against the schemas that advertise
    /// them.
    #[test]
    fn the_two_ends_are_routed() {
        assert_ne!(SPAWN_TOOL, CLOSE_TOOL);
        assert_eq!(spawn_schema()["name"], SPAWN_TOOL);
        assert_eq!(close_schema()["name"], CLOSE_TOOL);
        assert_eq!(close_schema()["inputSchema"]["required"][0], "card");
        /* `why` is offered and not required: a card closing one of its own
           never needs it, and demanding it there would be a field written to
           satisfy a schema. */
        assert_eq!(close_schema()["inputSchema"]["required"].as_array().unwrap().len(), 1);
        assert!(close_schema()["inputSchema"]["properties"]["why"].is_object());
    }

    /* ── what a parent is told when its children stop ─────────────────────── */

    /// The envelope has to wear the mark the front end already recognises, or
    /// it is drawn in the user's own register as something they typed.
    ///
    /// `later.rs` is the cautionary case and it is one file over: `WAKE_MARK` is
    /// its own string, chosen so the fold could tell "another agent asked me to"
    /// from "I asked myself to" — and the front end never learned it, so a wake
    /// is still drawn as a prompt you wrote. A fourth shape under a mark that is
    /// already recognised cannot fail that way.
    #[test]
    fn the_wall_speaks_in_an_envelope_the_panel_already_knows() {
        let text = envelope(&["\"a\" (aaaaaaaa)".into()], 0, 1);
        assert!(text.starts_with(crate::relay::RELAY_MARK), "{text}");
        /* The header `relay.ts::WALL` matches. Asserted as the literal line
           rather than as a prefix, because the regex there is anchored and a
           stray word before the dash would fall through to "another card" —
           the panel inventing an author for a line that has none. */
        assert!(text.contains("from the wall —\n\n"), "{text}");
        /* And the trailing note `relayBody` strips, which must be matched
           whole at the other end. */
        assert!(text.contains("\n\n(This came from the wall"), "{text}");
    }

    /// The three things the prose has to carry, each of which is a failure if
    /// it is missing.
    #[test]
    fn the_notice_answers_the_question_that_was_being_polled() {
        let text = envelope(&["\"tiering\" (3f08dc99)".into()], 2, 9);
        /* What settled. */
        assert!(text.contains("\"tiering\" (3f08dc99)"), "{text}");
        /* How many are left, as a fraction — "2 still working" and "2 of 9
           still working" are different amounts of knowing, and the second is
           the one that ends the round of `list` calls this exists to replace. */
        assert!(text.contains("2 of your 9 are still working"), "{text}");
        /* That no answer is wanted. A parent that replies to this has spent
           the turn the whole mechanism was built to save — the spiral
           `relay.rs` guards against, arriving through a door it does not
           watch. */
        assert!(text.contains("nobody is waiting on a reply"), "{text}");
        /* And the honest limit, which is the half that stops the notice being
           worse than nothing: quiet is not the same fact as finished, and the
           incident behind this item was a parent relaying a wrong conclusion
           to eight cards. */
        assert!(text.contains("Quiet is evidence, not a report"), "{text}");
        assert!(text.contains("`recall`"), "{text}");
    }

    /// One card, several cards, and the case where the parent's whole brood has
    /// gone quiet — which is the sentence it was really waiting for.
    #[test]
    fn it_counts_in_words_a_reader_expects() {
        let one = envelope(&["\"a\" (aaaaaaaa)".into()], 3, 4);
        assert!(one.contains("A card you opened has stopped:"), "{one}");
        assert!(one.contains("3 of your 4 are still working"), "{one}");

        let two = envelope(&["\"a\" (aaaaaaaa)".into(), "\"b\" (bbbbbbbb)".into()], 1, 5);
        assert!(two.contains("2 cards you opened have stopped:"), "{two}");
        assert!(two.contains("\"a\" (aaaaaaaa) and \"b\" (bbbbbbbb)"), "{two}");
        /* Singular, because "1 of your 5 are still working" is the kind of
           sentence that makes a reader distrust the number beside it. */
        assert!(two.contains("1 of your 5 is still working"), "{two}");

        /* The whole brood, and the notice says so plainly rather than making
           the parent subtract. */
        let all = envelope(&["\"a\" (aaaaaaaa)".into(), "\"b\" (bbbbbbbb)".into()], 0, 2);
        assert!(all.contains("Nothing else you opened is working."), "{all}");
    }

    #[test]
    fn names_are_listed_the_way_they_are_said_aloud() {
        let n = |s: &str| s.to_string();
        assert_eq!(list(&[]), "");
        assert_eq!(list(&[n("a")]), "a");
        assert_eq!(list(&[n("a"), n("b")]), "a and b");
        assert_eq!(list(&[n("a"), n("b"), n("c")]), "a, b, and c");
    }

    /// Both, because they answer different questions: the title is what the
    /// parent recognises and the handle is what `recall`, `send` and `close`
    /// take. A notice carrying only one of them costs a `list` call to use.
    #[test]
    fn a_card_is_named_by_title_and_by_handle() {
        let id = "3f08dc99-1111-4111-8111-111111111111";
        assert_eq!(named(id, Some(&"tiering".to_string())), "\"tiering\" (3f08dc99)");
        /* A card that has not named itself yet is the normal case for a child
           in its first minutes, and it still has to be addressable. */
        assert_eq!(named(id, None), "an untitled card (3f08dc99)");
        assert_eq!(named(id, Some(&"   ".to_string())), "an untitled card (3f08dc99)");
    }

    /// The two numbers are the whole of the bounding, so they are pinned
    /// against what they are each for rather than left as bare constants.
    #[test]
    fn the_grace_outlasts_a_pause_and_the_floor_bounds_the_cost() {
        /* Longer than the gap before a `<task-notification>` lands — measured
           at a ten-second median in `supervisor::turn_mark`'s note — and longer
           than `later::MIN_DELAY_S`, so the shortest wake a card can arm still
           cancels its own settle. */
        assert!(SETTLE_GRACE_MS >= 60 * 1_000, "a pause must not read as a stop");
        /* Twelve an hour, which is `later::MAX_SERVED` reached from the other
           direction — said as an interval rather than as a count, so there is
           one number and it cannot be off by one. */
        assert_eq!(60 * 60 * 1_000 / SETTLE_APART_MS, 12);
        /* And the grace has to fit inside the floor, or a notice would be due
           again before the previous one was allowed out. */
        assert!(SETTLE_GRACE_MS < SETTLE_APART_MS);
    }

    fn wall() -> Vec<crate::store::ProjectRow> {
        vec![
            row("p-atelier", "atelier", r"C:\atelier"),
            row("p-caravan", "caravan", r"C:\dev\caravan"),
            row("p-nova", "nova", r"C:\dev\nova"),
            row("p-old-nova", "nova", r"D:\archive\nova"),
            row("p-skein", "skein", r"C:\atelier\skein"),
        ]
    }

    fn row(id: &str, name: &str, root: &str) -> crate::store::ProjectRow {
        crate::store::ProjectRow {
            id: id.into(),
            name: name.into(),
            root_path: root.into(),
        }
    }

    /// The whole of the new argument: a card in one territory naming another.
    #[test]
    fn a_named_territory_is_the_one_it_names() {
        let w = wall();
        assert_eq!(standing(&w, "p-atelier", "caravan"), Standing::There(1));
        assert_eq!(standing(&w, "p-atelier", "skein"), Standing::There(4));
        /* Case and separators folded — a model typing a path back at us from
           `list` should not depend on which slash it chose. */
        assert_eq!(standing(&w, "p-atelier", "Caravan"), Standing::There(1));
        assert_eq!(standing(&w, "p-atelier", "c:/dev/caravan/"), Standing::There(1));
    }

    /// No argument and your own project are the same answer, and it is the
    /// parent's `cwd` rather than the project root — see `Standing::Here`.
    #[test]
    fn your_own_project_is_where_you_already_stand() {
        let w = wall();
        assert_eq!(standing(&w, "p-atelier", ""), Standing::Here);
        assert_eq!(standing(&w, "p-atelier", "   "), Standing::Here);
        assert_eq!(standing(&w, "p-atelier", "atelier"), Standing::Here);
        assert_eq!(standing(&w, "p-atelier", r"C:\atelier"), Standing::Here);
    }

    /// The bound. A path the caller composed is not a territory, and being a
    /// *subdirectory* of one is exactly the shape a model reaches for first.
    #[test]
    fn a_path_that_is_not_a_territory_is_nobody() {
        let w = wall();
        assert_eq!(standing(&w, "p-atelier", r"C:\atelier\skein\src-tauri"), Standing::Unknown);
        assert_eq!(standing(&w, "p-atelier", r"C:\Windows\System32"), Standing::Unknown);
        /* And a near miss is a miss: the name is what `list` says, not a
           description of it. */
        assert_eq!(standing(&w, "p-atelier", "the nova repo"), Standing::Unknown);
    }

    /// Only `root_path` is unique, so two territories can share a name — and
    /// picking the first would open a card with the machine in its hands in the
    /// wrong repository. The full path is the way out and the refusal says so.
    #[test]
    fn one_name_over_two_territories_picks_neither() {
        let w = wall();
        assert_eq!(standing(&w, "p-atelier", "nova"), Standing::Ambiguous);
        assert_eq!(standing(&w, "p-atelier", r"D:\archive\nova"), Standing::There(3));
        assert!(offer(&w).contains(r"D:\archive\nova"), "the refusal has to carry the paths");
    }

    /// Chat cards' address is a folder beside the database, and `#openIn` writes
    /// a project row for it like any other directory. It is in the table without
    /// anybody having declared it, so it is not on offer.
    #[test]
    fn skeins_own_directory_is_not_a_territory() {
        let data = std::path::PathBuf::from(r"C:\Users\a\AppData\Roaming\skein");
        assert!(is_skeins_own(r"C:\Users\a\AppData\Roaming\skein\chat", &data));
        assert!(is_skeins_own(r"c:/users/a/appdata/roaming/skein", &data));
        /* A sibling that merely starts with the same characters is somebody's
           actual repository. */
        assert!(!is_skeins_own(r"C:\Users\a\AppData\Roaming\skein-notes", &data));
        assert!(!is_skeins_own(r"C:\atelier\skein", &data));
    }

    /// The brief is the whole of what the child gets, and an agent that does not
    /// know that writes one line and spends a card rediscovering the context.
    #[test]
    fn the_prompt_field_says_it_shares_nothing() {
        let d = spawn_schema()["inputSchema"]["properties"]["prompt"]["description"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(d.contains("not your context"), "{d}");
        assert!(d.contains("somebody who has just walked in"), "{d}");
    }

    /// Every bound on *how much* is off, and the point of asserting it is that
    /// the guards must genuinely not run rather than run against a value that
    /// happens to pass — a `0` or a negative in either number would refuse every
    /// spawn on the wall, which is the failure a sentinel invites and an `Option`
    /// cannot express.
    #[test]
    fn nothing_bounds_how_much() {
        assert_eq!(MAX_LIVE, None);
        assert_eq!(MAX_PER_HOUR, None);
        assert!(!ONE_GENERATION);
        /* The fourth, and the one that refused a *good* brief rather than a
           fan-out: sink f468f017 is a numbered list cut off inside the word
           `ask_user` at four thousand characters, with nothing said to either
           end about it. */
        assert_eq!(MAX_PROMPT, None);
    }

    /// The brief's own half of the same claim, and it is a separate sentence in
    /// the description because it answers a different question. "How many cards"
    /// and "how much may I write to one" are not the same bound, and an agent
    /// that believes the second is there summarises the brief down to a length it
    /// is guessing at — which is the failure this whole item is about, arrived at
    /// voluntarily instead of by being clipped.
    #[test]
    fn the_brief_says_it_is_not_clipped() {
        let s = spawn_schema();
        let d = s["inputSchema"]["properties"]["prompt"]["description"]
            .as_str()
            .unwrap();
        assert!(d.contains("Nothing clips this"), "{d}");
        assert!(d.contains("no length to write to"), "{d}");
        /* The reason, not just the fact — an agent told only "it is unlimited"
           still economises out of habit. */
        assert!(d.contains("reads as complete"), "{d}");
    }

    /// `clip_brief` has no caller today (see `MAX_PROMPT`) and is tested anyway,
    /// exactly as `store::spawns_since` is kept for the rate limit: the day a cap
    /// comes back is the day this has to already be right, and a `Some(n)`
    /// written in a hurry is not going to think of the marker.
    ///
    /// The two halves are separate claims. Cutting at a boundary stops a card
    /// reading half a word; the **marker** is the one that tells the truth,
    /// because a brief clipped at a paragraph reads as finished — which is the
    /// trap the incident only escaped by the cut landing mid-token.
    #[test]
    fn a_clipped_brief_stops_somewhere_and_says_so() {
        assert_eq!(clip_brief("short", 4_000), ("short".into(), 0));

        /* Exactly at the budget is not over it. */
        let exact = "x".repeat(40);
        assert_eq!(clip_brief(&exact, 40), (exact.clone(), 0));

        /* A paragraph boundary is preferred, and the marker names what went. */
        let para = "p".repeat(32);
        let brief = format!("{para}\n\n{}", "b".repeat(60));
        let (text, gone) = clip_brief(&brief, 40);
        assert!(text.starts_with(&para), "{text}");
        /* Split at the marker before looking: the marker is prose and has its
           own letters in it, so a bare `contains` over the whole thing asks the
           wrong question — which this assertion did, and the lift said so. */
        let kept = text.split_once("\n\n[brief truncated").expect("a marker").0;
        assert_eq!(kept, para, "the second paragraph was not dropped whole: {text}");
        assert_eq!(gone, brief.chars().count() - para.chars().count());
        assert!(text.contains("brief truncated by the wall"), "{text}");
        assert!(text.contains(&gone.to_string()), "the count is not in the marker: {text}");
        /* Named so the card can act rather than infer, which is the whole join
           between this item and `0cf05791` — it now knows who opened it. */
        assert!(text.contains("Ask the card that opened you"), "{text}");

        /* A list, which is the shape the reported brief was in: the cut takes
           whole items. */
        let list = "1. one\n2. two\n3. three\n4. four\n5. five";
        let (text, gone) = clip_brief(list, 24);
        assert!(text.starts_with("1. one\n2. two\n3. three"), "{text}");
        assert!(!text.contains("4. four"), "half an item survived: {text}");
        assert!(gone > 0);

        /* With no break of any kind, a space still beats a mid-word cut — which
           is the literal complaint in the item, a brief ending inside the word
           `ask_user`. */
        let (text, _) = clip_brief(&format!("{} {}", "w".repeat(35), "x".repeat(30)), 40);
        assert_eq!(text.lines().next().unwrap(), "w".repeat(35));

        /* And a boundary too far back is not taken. One blank line near the
           start of a wall of prose would otherwise clip a 5,000-character brief
           to two characters — much worse than the mid-word cut this is meant to
           improve on — so each rule is tried in turn, each is refused for
           landing below the floor, and what is left is the cut that was always
           going to happen. */
        let mut prose = String::from("ab\n\ncd ");
        prose.push_str(&"e".repeat(60));
        let (text, _) = clip_brief(&prose, 40);
        assert!(text.starts_with("ab\n\ncd"), "the early blank line was taken: {text}");
        assert!(text.contains("eeee"), "nothing after the blank line survived: {text}");

        /* Nothing to cut on at all still cuts, at the budget. */
        let solid = "z".repeat(100);
        let (text, gone) = clip_brief(&solid, 40);
        assert_eq!(gone, 60);
        assert!(text.starts_with(&"z".repeat(40)), "{text}");

        /* Counted in characters rather than bytes, since that is what the budget
           is measured in — a marker claiming three times the real number is an
           instrument lying about itself. */
        let wide = "é".repeat(100);
        let (_, gone) = clip_brief(&wide, 40);
        assert_eq!(gone, 60);
    }

    /// With nothing left to refuse a spawn on grounds of quantity, the tool has
    /// to *say* so. An agent that believes a limit is there treats the wall as
    /// something that will stop it, and this is the one tool on the server where
    /// that belief costs the user money — so the description carries the absence
    /// of the bound as plainly as it used to carry the bound.
    #[test]
    fn the_description_does_not_promise_a_limit_that_is_not_there() {
        let s = spawn_schema();
        let d = s["description"].as_str().unwrap();
        assert!(d.contains("Nothing limits how many"), "{d}");
        assert!(d.contains("can open cards of its own"), "{d}");
        /* And what replaces it, which is the agent's own judgement and the tidying
           up — a wall nobody clears is the failure this now runs into first. */
        assert!(d.contains("your judgement"), "{d}");
        assert!(d.contains("`close`"), "{d}");
        /* The bound that is still real must not be softened in the same breath. */
        assert!(d.contains("cannot point it at an arbitrary path"), "{d}");
    }
}
