//! Owns the `claude` child processes.
//!
//! One conversation is one long-lived `claude -p` process speaking NDJSON over
//! stdin and stdout. There is no terminal emulator anywhere on this path: the
//! child emits structured events, and the front end renders them as its own
//! design rather than as somebody else's TUI.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
/// Keep spawned children from flashing a console window on Windows.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Take the machine away from a card, leaving it the web.
///
/// Probed against claude 2.1.233 on 2026-08-16, spawning with Skein's argv:
///
/// ```text
/// --tools WebSearch,WebFetch, then asked to:
///   read a file, with --dangerously-skip-permissions as well  → no tool for it
///   run a shell command, likewise                             → no tool for it
///   WebFetch file:///C:/…/secret.txt                          → refused
///   WebFetch http://127.0.0.1:8899/ (a live local server)     → refused
///   search the web                                            → answers
/// ```
///
/// Three things that are not obvious and cost an afternoon each:
///
/// - **`--tools ""` does not disable tools.** The CLI's own help says it does.
///   The flag is variadic, the empty argument is swallowed, and what comes back
///   is the full default set — `Read Edit Write Glob Grep PowerShell Bash`. The
///   tools are always named explicitly here for that reason.
/// - **`--tools` filters the built-in set only; MCP tools pass straight
///   through.** That is what keeps `ask_user` working on a chat card, which is
///   the one capability it genuinely wants. It also means every *other* MCP
///   server the user has configured would arrive with whatever reach it has, so
///   `--strict-mcp-config` pins the card to the one server Skein passes.
/// - **There is no `Agent` in the filtered set**, so there is no subagent to
///   come back holding a fuller toolset than its parent.
///
/// What this is not: a sandbox. The process still runs as you, with your rights
/// — what is true is that the model has no route to them, not that the route
/// has been closed. A hook, a plugin or a later flag that reintroduces a tool
/// moves this boundary without touching this function.
fn chat_argv(cmd: &mut Command) {
    cmd.args(["--tools", "WebSearch,WebFetch"])
        .arg("--strict-mcp-config");
}

/// What the CLI prefixes an MCP tool with: the server name Skein passes in
/// `ask::mcp_config`. Nothing about a card can call `board`; the name is
/// `mcp__skein__board`.
pub(crate) const MCP_PREFIX: &str = "mcp__skein__";

/// The `--append-system-prompt` every card is spawned with.
///
/// Two paragraphs, and the second only where it is usable. Every word here is
/// paid for on every spawn of every card, so the roster half is kept to what the
/// tool descriptions cannot say and is left off a chat card, which `relay.rs`
/// refuses both tools to anyway — telling it about them would be an instruction
/// to try something it will be told it may not do.
///
/// **The tools are named as the agent must call them.** This read `ask_user`,
/// `board`, `post` for most of its life, and not one of those is a name any card
/// can use — so the one paragraph guaranteed to be in front of every agent spent
/// its length naming five identifiers that resolve to nothing. It is the worst
/// shape a wrong instruction can take, because it reads as correct to whoever
/// wrote it and fails silently for the agent: the tools were *there*, they were
/// described, and the card was pointed at names for them that did not exist.
/// `the_prompt_names_only_tools_the_server_advertises` is the guard, and it asks
/// `ask::dispatch` rather than a list kept here — a renamed tool has to break
/// this rather than quietly strand a sentence.
///
/// And it is short because it is allowed to be: every tool it names is in
/// `ask::roster`'s **loaded** tier, so each arrives with its own description
/// attached rather than as a bare name behind a `ToolSearch` step. That is where
/// the reasoning lives — why reading the board is free where a `send` costs the
/// other agent a turn, why a notice wants `paths`, why `unpost` is nobody else's
/// job — and re-stating it here would be the same words paid for twice, in the
/// copy that can silently drift out of step with the schema.
///
/// **It used to say `ask::mcp_config` sets `alwaysLoad`, and that has not been
/// true since the roster grew two tiers** (`871075a`, `b8f6276`). The
/// server-level field is deliberately absent now: the client takes the *union*
/// of it and each tool's `_meta["anthropic/alwaysLoad"]`, so setting it would
/// override every per-tool decision and put all 22 schemas in front of every
/// card on every turn. The conclusion survives by the other route — `ask::roster`
/// states as a rule that everything named here is in the loaded tier — but the
/// route mattered, because the old wording said the guarantee came from a line
/// that no longer exists.
///
/// So it is guarded from this end too.
/// `the_prompt_names_only_tools_whose_schemas_are_loaded` asks the roster which
/// tools carry the flag and refuses a prompt that names one which does not.
/// Deferring a tool named here would otherwise cost the card nothing visible: it
/// is still advertised, `the_prompt_names_only_tools_the_server_advertises` still
/// passes, and the description simply is not there — which is this paragraph
/// becoming the whole of what a card knows, silently, one tier edit away.
/// Everything appended to a card's system prompt, as the one argument the CLI
/// will actually read.
///
/// `--append-system-prompt` is last-one-wins, so this exists to make "two
/// things to append" impossible to express. Both callers used to pass their own
/// and the person's standing instructions lost every time.
///
/// **Order: the tooling first, their words last.** Two reasons, and they agree.
/// The roster paragraph is about how to use this studio and is the same on every
/// card; the standing instructions are the person's own, are the more specific
/// of the two, and are the thing that must not read as a footnote to a paragraph
/// about tool names. It is also the order `guidance::compose` already argues for
/// internally when the wall's instructions and a territory's disagree — the more
/// specific and more human one goes last and wins.
///
/// `ask` is whether the MCP server actually came up. With no server the roster
/// paragraph would name tools that are not there, which is the failure
/// `the_prompt_names_only_tools_the_server_advertises` guards from the other
/// direction — so it is left out, and the standing instructions still go.
fn system_prompt(
    chat: bool,
    ask: bool,
    standing: Option<String>,
    me: Option<&Selfhood>,
) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    if ask {
        parts.push(append_prompt(chat, me));
    }
    if let Some(text) = standing {
        let text = text.trim();
        if !text.is_empty() {
            parts.push(text.to_string());
        }
    }
    if parts.is_empty() {
        return None;
    }
    Some(parts.join("\n\n"))
}

/// What a card knows about *itself*, as the only channel that can tell it.
///
/// Three sink items turned out to be one gap — `be79bb41` (a card is never told
/// its own handle), `0cf05791` (a spawned card is not told it was spawned, or by
/// whom) and the half of `f468f017` about a brief arriving with no way to tell
/// it was incomplete. All three are the same question asked from different
/// sides: **what does a card know about itself and where it came from**, and the
/// answer in every case was *nothing it did not go and ask for*.
///
/// Why the system prompt rather than the brief, which is the obvious place:
///
/// - **The brief is the parent's own words**, echoed into the transcript exactly
///   as a typed prompt is (`spawn.md`). The complaint in `0cf05791` is precisely
///   that a brief is indistinguishable from something the user typed — Volery
///   prepending a paragraph of its own to it makes that worse rather than
///   better, and puts words in the parent's mouth to say so.
/// - **A brief scrolls away.** Provenance is true of a card for its whole life
///   and is wanted at the moment it is *needed*, which is usually hours later
///   and on the far side of a compaction. A system prompt is the one channel
///   that survives both.
/// - **It costs no round trip.** The measured failure was a card checking
///   `list`, finding no parent field, concluding from the absence that it was
///   top-level, and telling the user there was no orchestrator to report to.
///   Every part of that is a card doing work to learn something it could have
///   been handed.
///
/// A card already running does not hear an edit, per `guidance.md` — which does
/// not bite here, because this is derived at every spawn and every wake is a
/// spawn. A card roused a month from now is told again.
pub struct Selfhood {
    /// This card's own handle: the eight characters everything on this wall
    /// addresses it by, and the thing `.scratch-<handle>/` is spelled from.
    pub handle: String,
    /// Who opened it, where they stand, and whether that is somewhere else.
    pub spawned_by: Option<crate::store::Provenance>,
}

fn append_prompt(chat: bool, me: Option<&Selfhood>) -> String {
    let mut prompt = format!(
        "When you need a decision that only the user can make, call \
         `{MCP_PREFIX}ask_user` rather than ending your turn with a question. It \
         keeps your turn open and resumes the moment they answer. Give it \
         `options` whenever the answer is a choice between alternatives."
    );
    if !chat {
        prompt.push_str(&format!(
            "\n\nOther Claude Code conversations may be working on this wall \
             beside you, sometimes in the same repository. Before starting \
             anything substantial, read `{MCP_PREFIX}board` — the standing \
             notices about what the others are holding. It costs nobody a turn. \
             `{MCP_PREFIX}post` puts your own notice up when you take on \
             something others build on, and `{MCP_PREFIX}unpost` takes it down \
             the moment it stops being true. `{MCP_PREFIX}list` says who else is \
             here and `{MCP_PREFIX}send` puts a message in one card's hands — \
             which costs that agent a turn, so read the board first."
        ));
        /* The tree, not the index — and this is the half nothing guarded.
           `hooks::sweep` catches a commit that would sweep a sibling's *staged*
           work, so `git add -A` and `git commit -a` are already denied. Nothing
           caught `git stash`, which is not a commit and never reaches that
           guard: it takes every card's uncommitted work out of the tree in one
           silent stroke, and does not even carry untracked files into the stash
           it makes, so a `git clean` beside it is unrecoverable outright.

           Measured 2026-08-27: one card ran `git stash` in a tree nine cards
           shared, wiping nine files across four of them with no error shown to
           anybody, and it was found only because a card happened to read back a
           file it had just written. That card *knew* the tree was shared and
           reached for the tool anyway while chasing a build error — which is
           the whole argument for this being a sentence here *and* a deny in
           `hooks.rs`, rather than either on its own. An instruction does not
           bind a reflex, and a card that has never read the board is one no
           instruction reaches at all.

           It says "ask the user" rather than "unless the user asked", because
           the caveat an agent grants itself is the one it grants while chasing
           a build error. Routing through `ask_user` costs a question and keeps
           the judgement with the person whose tree it is.

           Left off a chat card with the rest of this block, and for a reason
           already written down: a chat card cannot touch a file, so it can
           never be in a clash — see `chat.md`. */
        prompt.push_str(
            "\n\nCards can share one working tree, and then they share its git \
             index too. Commit with `git commit -- <explicit paths>`, never \
             `git add -A` or a bare `git commit`. Never run `git stash`, \
             `git reset`, `git checkout -- .` or `git clean` there — each wipes \
             every other card's uncommitted work at once, silently, and a stash \
             does not even keep untracked files. Make a worktree if you need a \
             clean tree, and if you think you genuinely need one of those \
             commands, ask the user rather than running it.",
        );
        /* One sentence for `drop`, where the other tools on this server get
           none, and the asymmetry is the whole reason it is here. `alwaysLoad`
           puts every description in front of the agent — that is the argument
           above for keeping this paragraph short — but a description is only
           read by an agent that has thought to look for a tool, and the reflex
           this fights is *not thinking there is anything to do*. An observation
           made in passing has a default, and the default is silence. Nothing in
           a schema reaches that. */
        prompt.push_str(&format!(
            "\n\nWhen you notice something worth keeping that is not what you were \
             asked to do — a bug you walked past, a rough edge, a thing that should \
             exist — put it in `{MCP_PREFIX}drop` rather than losing it or breaking \
             your task to chase it. It outlives this conversation."
        ));

        /* The two browsers, because nothing else can tell a card they differ.
           `@playwright/mcp` writes its own tool descriptions and they are
           upstream of this repo — they cannot mention a shared Chrome, a widget
           somebody is watching, or a session vault, because none of those exist
           in the world that server knows about. That is exactly the bar this
           paragraph is held to: what the descriptions cannot say.

           And the cost of *not* saying it is asymmetric, which is what makes it
           worth the words. Two similarly-named browser tool families with
           interchangeable-looking descriptions is a coin flip, and one side of
           that flip is expensive: an agent that takes the shared browser and
           clears cookies in its teardown — routine, and the correct instinct
           everywhere else — signs every other card on the wall out of
           everything at once. So the prohibition is stated before the choice
           is.

           It does **not** promise the browsers are signed in, and that was a
           correction: they usually are, and the case that matters is the one
           where they are not. An agent told "already signed in" that finds a
           login page has been handed a contradiction, and the reflex under a
           contradiction is to improvise — which here means trying credentials
           it does not have, or worse, finding some. So the sentence says what
           to do instead, and routes the ordinary answer to the person, because
           signing in to a company's staging environment is theirs to do and not
           a decision an agent should reach for.

           `ask_user` is named rather than described because it is on this
           server's loaded tier and is already the first paragraph's subject —
           pointing at it costs four words, where explaining the gesture again
           would cost thirty.

           **It is deliberately half the length it wants to be**, and the cut is
           Anthropic's own rule applied honestly: domain knowledge that is only
           *sometimes* relevant belongs in a skill, loaded on demand, rather than
           in the prompt every conversation pays for — and browser testing is
           sometimes. What survives the cut is only what an agent cannot be told
           later, because by then it has already done the damage: that the shared
           browser is shared, that its cookies are not its own, and that a login
           page is a question for the user rather than a puzzle. The vault, the
           widget, `VOLERY_CDP_ENDPOINT` and the whole of why any of it is shaped
           this way are in `.claude/rules/browser.md`, which loads when somebody
           opens a file it governs and costs nothing otherwise. Anything that
           wants to be added here should be added there instead unless it passes
           the same test: would an agent that learned it too late already have
           broken something for somebody else?

           Left off a chat card with the rest of this block: a chat card spawns
           with `--tools WebSearch,WebFetch` and no MCP server but this one, so
           it has neither browser and telling it about them would be an
           instruction to try something it will be refused. See `chat.md`.

           NOTE the coupling, which is real and is recorded in
           `.claude/rules/browser.md`: the two server *names* here come from the
           user's own MCP configuration, which this app does not write. If they
           are renamed this paragraph strands, and `named_tools` cannot catch it
           because that guard is scoped to `MCP_PREFIX` by construction. The fix
           is for Volery to supply both servers in the per-card `--mcp-config`
           it already builds, and until it does, the test below is the only
           thing holding the two ends together. */
        prompt.push_str(&format!(
            "\n\nTwo browsers are on this wall. `mcp__browser__*` is the one \
             Chrome this studio owns — a single session every card shares and the \
             user can watch, so never sign it out or clear its cookies. \
             `mcp__playwright__*` is your own, seeded with the same sign-ins; use \
             it if you need a different login or to clear state as you go. \
             Neither is guaranteed to be signed in — ask with \
             `{MCP_PREFIX}ask_user` rather than improvising credentials."
        ));

        /* Project cards only, with the rest of this block. A chat card cannot
           write a file, so it has no scratch directory to name — and `do_list`
           refuses it the roster outright, so telling it which row is its own
           would name a thing it will be told it may not look at. Same argument
           as the `git stash` paragraph above, one tool over. */
        if let Some(me) = me {
            /* Sink `be79bb41`. The handle was always *gettable* — `list` marks
               your own row `you: true` — and that is the whole complaint: a
               convention you have to make a round trip to obey is one that gets
               skipped under load. `SKEIN_CARD` in the environment is the other
               half of this and reaches the shell (see `spawn_now`); this half
               reaches a card that has never read a `CLAUDE.md`. */
            prompt.push_str(&format!(
                "\n\nYou are card `{}` on this wall. That is your handle: it is what \
                 `{MCP_PREFIX}list` reports for the row marked `you`, what another card \
                 addresses you by, and what a repository asking for a per-card scratch \
                 directory means by your handle. It is also in your environment as \
                 `$SKEIN_CARD`, so a shell command never has to spell it from memory.",
                me.handle,
            ));

            /* Sink `0cf05791`, and the sentence the whole item is about. */
            if let Some(p) = &me.spawned_by {
                let where_they_are = match (&p.project, p.elsewhere) {
                    /* The measured case: parent in `rise`, child in
                       `workbench`. `list` defaults to project scope, so the
                       parent is not in the rows this card can see at all
                       without asking for the wider one — and a card that looks
                       and finds nothing concludes it has no parent, which is
                       exactly what happened. */
                    (Some(name), true) => format!(
                        " It stands in a different territory from you — the {name} project — \
                         so it is **not** in your default `{MCP_PREFIX}list`; ask for \
                         `scope: \"skein\"` to see it. It knows nothing about the \
                         repository you are in beyond what it wrote in your brief."
                    ),
                    (Some(name), false) => format!(
                        " It stands where you do, in the {name} project, so it is in your \
                         ordinary `{MCP_PREFIX}list`."
                    ),
                    /* Closed since. Still the card that wrote the brief, and
                       still worth naming — but nothing can be sent to it, and a
                       card told to report to a handle that answers nothing has
                       been sent on an errand instead of told the truth. */
                    (None, _) => " It has since been closed, so there is nobody to report \
                                  back to — tell the user instead."
                        .to_string(),
                };
                prompt.push_str(&format!(
                    "\n\n**You are a spawned card.** Your first turn is a brief written by \
                     another conversation on this wall — card `{}` — rather than by the \
                     person at the keyboard.{where_they_are} Report back to it with \
                     `{MCP_PREFIX}send` when you have finished or are stuck, rather than \
                     only telling the user; it is waiting on you and cannot see your \
                     transcript. If the brief looks incomplete or contradicts itself, ask \
                     it — that costs one message and is always cheaper than inferring what \
                     it meant.",
                    p.parent,
                ));
            }
        }
    }
    prompt
}

pub struct Conv {
    child: Child,
    stdin: ChildStdin,
    /// The job object holding this card's whole process tree.
    ///
    /// `child.kill()` is `TerminateProcess` and it reaches exactly one process:
    /// the `claude.exe` itself. But a card is never one process. Each one spawns
    /// a `cmd.exe` → `node.exe` pair per stdio MCP server, a `conhost.exe`, and
    /// a `bash.exe` for every Bash tool call it makes — and those outlive the
    /// agent that started them whenever they are backgrounded or simply hang.
    /// Measured on this machine on 2026-08-19: one Skein up since the previous
    /// evening carried 80 descendants for 6 cards, among them a `bash → bash →
    /// bash → bun` chain sixteen hours old under a card that had long since
    /// finished with it.
    ///
    /// So killing the child orphaned the rest, `close_conversation` reclaimed
    /// nothing, and `shutdown` left the whole lot running after the app was
    /// gone — which is how the count only ever went up across a day. Dropping
    /// this takes the tree down (`KILL_ON_JOB_CLOSE`), and it is the same
    /// bargain `servers.rs`, `bang.rs`, `shell.rs` and `actions.rs` each already
    /// struck; this was the one spawn in the app that had not.
    ///
    /// The deliberate exception stays deliberate: `actions::launch_detached`
    /// spawns from *Skein*, not from a card, so an editor still outlives the
    /// wall. What changes is that an editor a card opened through its own Bash
    /// tool now dies with that card, which is the same promise the doc comment
    /// on `shutdown` has always made.
    job: Option<crate::servers::jobs::Job>,
    /// The tree as it stood when this card's first turn ended — its *fleet*, and
    /// the baseline `leftovers` measures against.
    ///
    /// A card is a dozen processes at rest and that is normal: one `claude.exe`,
    /// a `conhost`, and a `cmd → node` pair per stdio MCP server. Measured on
    /// this machine 2026-09-01, a fully equipped card is 12 processes and ~1.1 GB
    /// of private commit before it has been asked anything. So a badge counting
    /// what a card owns would read ~11 on every card on the wall, always, which
    /// is a number nobody can act on — the wall would be uniformly loud and
    /// therefore uniformly ignored.
    ///
    /// What is worth seeing is the *excess*: a headed Chromium still rendering
    /// after the task that opened it was torn down, a dev server a turn started
    /// and never stopped. Those are the ones with nobody carrying them, and the
    /// incident behind this — a WebGL scene left at 60fps on a card nobody was
    /// talking to, which read as ambient machine load and nearly went into an
    /// audit report as a finding — is exactly the shape.
    ///
    /// Captured at the end of the *first* turn rather than at spawn, because the
    /// MCP fleet is still booting when the child is inserted here: `claude`
    /// starts its stdio servers on the way to answering, so a baseline taken at
    /// spawn would be almost empty and every server would then read as a leak.
    /// `None` until then, and a card that has never taken a turn has no reading
    /// rather than a wrong one.
    ///
    /// The known imprecision: a server that boots lazily, after the first turn,
    /// is counted as excess for the rest of the card's life. That is the
    /// conservative direction — it over-reports rather than hiding a leak — and
    /// it is rare enough to be worth the simplicity of one fixed baseline.
    fleet: Option<HashSet<u32>>,
    /// Whether a turn is open on this child right now.
    ///
    /// The one thing the supervisor needs to know about the *conversation*
    /// rather than about the process: a card that lost a turn when the app went
    /// away is sent a resume prompt at the next launch, and having a process is
    /// not the same fact as being mid-turn. Shared with the reader thread, which
    /// is the only place the answer changes on its own.
    ///
    /// It is also written through to the row as it changes (`store::set_mid_turn`),
    /// which is what makes the flag survive a crash — see there.
    turn: Arc<AtomicBool>,
    /// Which spawn this is. A card's id outlives its processes — an account
    /// swap, a repair, a clear all end one child and start another under the
    /// same id — so the id alone does not say *which* process a reader thread
    /// is talking about, and `reap` used to assume it did.
    ///
    /// The consequence was a live child nothing could reach. `close_conversation`
    /// takes the entry out of the map and waits for the process, but the reader
    /// thread is still on its way out at that point: it has a `persist_turn` to
    /// write first, which takes the store's lock and touches SQLite. If the next
    /// spawn lands inside that window — and `#moveTo` in `skein.svelte.ts` used
    /// to close and wake in the same breath — the old thread's `reap` removed the
    /// *new* child, waited on it (parking that thread until it died), and emitted
    /// a `conv:exit` for a card whose process was running fine. From then on
    /// `send_prompt` answered "no open conversation", `close_conversation` could
    /// not kill it, and the perf widget could not name it.
    ///
    /// So a reader thread reaps by generation as well as by id, and one that has
    /// been superseded reaps nothing. Monotonic and never reused, which is all
    /// this has to be.
    generation: u64,
}

/// Stamps each spawn, so a reader thread can tell its own child from its
/// successor. See `Conv::generation`.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// `.0` is the live children; `.1` says the app is on its way out; `.2` is the
/// ids a spawn is part-way through starting.
///
/// The second exists for one race with one consequence. A reader thread clears
/// the row's mid-turn mark when its stream ends, because a child that died with
/// a turn open is a card standing on the wall saying so — you can see it, and
/// resuming it tomorrow would spend money on a failure already reported. But
/// `shutdown` ends every stream too, by killing them, and *that* is exactly the
/// case the mark is for. So the flag is raised before the first kill and the
/// reader threads read it on their way out.
///
/// **The third exists because `.0` alone could not answer "is this card already
/// open" during the one window where it matters.** `spawn_now` asked that of the
/// map at its first line and did not enter the map until its last, and between
/// those it reads the store three times, works out where the CLI is, makes a git
/// worktree — including a network `fetch` — and calls `CreateProcess`. That is
/// not a tick, it is seconds, and it runs on the blocking pool, so two callers
/// can be inside it at once and both be told the card is free. The result is two
/// `claude` children resuming one session, of which the map keeps the **second**:
/// the first is dropped on the floor by the `insert` that overwrites it, still
/// running, still `--dangerously-skip-permissions` in the same repository, with
/// no handle left to kill it and nothing on the wall that knows it is there.
/// Reserving the id up front is what makes the guard mean what it always said.
#[derive(Default)]
pub struct Supervisor(pub Mutex<HashMap<String, Conv>>, AtomicBool, Mutex<HashSet<String>>);

/// A reservation on an id, held for as long as a spawn is working on it.
///
/// `Drop` rather than a call at each exit, because `spawn_now` is a column of
/// `?` — a store read, a home directory, `worktree::ensure`, the spawn itself —
/// and a release that has to be remembered at each of them is one that will be
/// missed at the next one added. A missed release is the worse failure: the id
/// stays reserved for the life of the process and that card can never be woken
/// again.
struct Claim<'a> {
    sup: &'a Supervisor,
    id: String,
}

impl Drop for Claim<'_> {
    fn drop(&mut self) {
        if let Ok(mut starting) = self.sup.2.lock() {
            starting.remove(&self.id);
        }
    }
}

#[derive(Clone, Serialize)]
struct ConvEvent {
    id: String,
    event: serde_json::Value,
}

#[derive(Clone, Serialize)]
struct ConvLine {
    id: String,
    line: String,
}

#[derive(Clone, Serialize)]
struct ConvExit {
    id: String,
    code: Option<i32>,
}

/// Start a conversation. `id` is a UUID minted by the front end and handed to
/// `--session-id`, so our record and the on-disk transcript are correlated from
/// birth — which is what makes `--resume` work later without a lookup table.
///
/// `session_id` separates the two for the one case where they differ: a cleared
/// card keeps its `id` — its placement, its turns, its file touches all key on
/// it — while pointing at a fresh session. Everything else here stays keyed by
/// `id`, including the supervisor map, the emitted events and the ask URL, so
/// only the argv the CLI reads is affected. Absent, it is the id, which is the
/// whole of a card's life until somebody clears it.
///
/// **Whether to resume is asked of the disk, not of the caller.** It is one
/// question — is there a transcript for this session — and the file either is
/// there or is not, so a flag passed down from the front end could only ever be
/// a second, staler answer to it. It was one: `resume: conv.everSpoke`, which
/// is `last_ending IS NOT NULL`, meaning *did a turn ever finish*. A card killed
/// part-way through its first turn has a transcript and no ending, so it came
/// back wanting `--session-id` against an id the CLI already knew, and the child
/// died on the spot — the exact case rousing wakes first, since an interrupted
/// card is the one with work standing still.
///
/// Probed against claude 2.1.232 with `tools/probe-resume.ts`, spawning with
/// Skein's exact argv:
///
/// ```text
/// --session-id <fresh>, never spoken to  → no transcript file is written at all
/// --resume <that same id>                → exit 1, "No conversation found with
///                                          session ID: …", plus a result event
/// --session-id <id with a transcript>    → exit 1, "Error: Session ID … is
///                                          already in use.", and nothing at all
///                                          on stdout
/// ```
///
/// The first line is what makes the file the whole answer: a spawn that was
/// never spoken to leaves nothing behind, so the file existing means something
/// was said and can be resumed. It corrects the other direction too — a row
/// claiming an ending whose transcript has since been deleted now starts fresh
/// instead of dying on the second message above.
/// `async`, through `off_main`, for the reason the other three here are: this
/// starts a process. On Windows that is tens of milliseconds of `CreateProcess`
/// before anything else, and it is preceded by a store read and a `signed_in`
/// check that both touch disk. One card is a stutter; `rouse` gives *every*
/// dormant card on the wall its process back at launch, sequentially, and on the
/// main thread that was the whole start-up unpainted. See `crate::off_main`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn spawn_conversation(
    app: AppHandle,
    id: String,
    session_id: Option<String>,
    cwd: String,
    account_label: Option<String>,
) -> Result<(), String> {
    crate::off_main(move || spawn_now(&app, id, session_id, cwd, account_label)).await?
}

/// The spawn itself, apart from the command that carries it — so the `app` it
/// works from is an owned handle rather than a borrowed `State`, which is what
/// makes it liftable onto the blocking pool at all.
#[allow(clippy::too_many_arguments)]
fn spawn_now(
    app: &AppHandle,
    id: String,
    session_id: Option<String>,
    cwd: String,
    account_label: Option<String>,
) -> Result<(), String> {
    let sup = app.state::<Supervisor>();
    /* Held for the rest of this function, and released whichever way it leaves.
       This used to be a bare `contains_key` here and an `insert` at the far end,
       which is a guard with the whole of the spawn inside its own window — see
       `Supervisor`, and note that the window contains a network `git fetch` for
       a worktree card. */
    let _claim = sup
        .claim(&id)
        .ok_or_else(|| format!("conversation {id} is already open"))?;
    let session = session_id.as_deref().filter(|s| !s.is_empty()).unwrap_or(&id);

    /* Asked of the store, never of the caller — see `store::kind_of`. `wake`
       and `open` both reach this line and only one of them would have
       remembered to pass it. */
    let chat = crate::store::kind_of(&app.state::<crate::store::Store>(), &id) == "chat";

    /* And so is what the card was set up as. `model` used to be a parameter of
       this function and was passed by nobody, which is the shape of the bug
       before it happens: the one caller that would have had to remember is
       `wake`, and a card that comes back from a rouse on the default model is a
       preset that stopped holding at the moment nobody was looking. See
       `store::setup_of`. */
    let (model, effort) =
        crate::store::setup_of(&app.state::<crate::store::Store>(), &id);

    /* And so is the tree it works in, for the third time and the same reason.
       This one used to be a parameter, and it is the one that proves the rule:
       `open` passed it and `wake` passed `null`, from the day the app was
       written. That was harmless while `--worktree` was a flag the CLI kept
       across a `--resume` and became a live bug the moment this module started
       making the tree itself — every card woken by a click, a send, a rouse or
       an account transition came back running in the main tree, sharing a
       checkout with whatever else was there and filing its transcript under the
       wrong slug, which is a card that has quietly lost its memory as well as
       its place. See `store::worktree_of`. */
    let worktree = crate::store::worktree_of(&app.state::<crate::store::Store>(), &id);

    /* The path `claude.rs` verified, not the bare name. On a machine where the
       CLI is installed but never made it onto PATH, the bare name fails every
       spawn on the wall with a message about a missing program, for a binary
       sitting in plain sight in ~/.local/bin. Worked out once and cached. */
    let program = {
        let home = app.path().home_dir().map_err(|e| format!("no home dir: {e}"))?;
        crate::claude::program(&home)
    };
    /* Where the child actually runs, which is not always where the card says it
       lives. A worktree card's `cwd` in the store is the project root — that is
       its territory, and what every other subsystem means by it — while the
       agent belongs in the tree for its branch. `ensure` makes that tree on the
       first spawn and finds it on every one after, so waking a dormant card
       puts it back in the tree it has been working in.

       This used to be `--worktree <name>`, one flag, the CLI doing all of it.
       What it did with the name is why it is not any more: the branch came out
       `worktree-feat+async-auth` for a card called `feat/async-auth`, and there
       is no flag to ask for anything else. See `worktree.rs`. */
    let run_dir = match worktree.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
        /* Never for a chat card, whose cwd is a folder of Skein's own —
           branching it would put a git tree somewhere nobody asked for one, for
           an agent with no tool to edit it. */
        Some(name) if !chat => crate::worktree::ensure(&cwd, name)?,
        _ => cwd.clone(),
    };

    let mut cmd = Command::new(&program);
    cmd.current_dir(&run_dir)
        .arg("--print")
        .args(["--input-format", "stream-json"])
        .args(["--output-format", "stream-json"])
        .arg("--verbose")
        .arg("--include-partial-messages")
        .arg("--replay-user-messages")
        .arg("--forward-subagent-text");

    /* And the gear, for the fourth time and the same reason as the three above:
       `open` could pass it, `wake` could not, and the card `wake` forgets is one
       put into planning and roused at launch with the machine back in its hands.
       See `store::gear_of`. */
    let gear = crate::store::gear_of(&app.state::<crate::store::Store>(), &id);

    if chat {
        chat_argv(&mut cmd);
    } else {
        match gear.as_deref() {
            /* A card nobody has ever set a gear on spawns exactly as every card
               did before gears existed. Kept as the flag rather than spelled
               `--permission-mode bypassPermissions`, because the flag is what
               every rule in this repository names and two spellings of one
               state is how a mode ends up set in one place and read in
               another. */
            None | Some("bypassPermissions") => {
                cmd.arg("--dangerously-skip-permissions");
            }
            Some(mode) => {
                cmd.args(["--permission-mode", mode]);
            }
        }
    }

    /* Every card, not only a chat card, because the layer now also carries the
       hook that undoes the Bash tool's backslash collapse — and a project card,
       being the one with a shell, is the one that needs it. `crate::hooks` has
       the measurements and why the compensator lives in this binary.

       The card's own id goes in with it, and the studio directory, which is what
       arms the shared-index guard: a hook process has no wall to ask who it is
       working for or where the record of that is kept, and both are constants of
       the process this layer is being built for. A chat card gets them too and
       will never use them — it has no Bash tool to run a commit with. */
    let studio = app.state::<crate::store::Store>().1.clone();
    cmd.args([
        "--settings",
        &crate::hooks::settings(chat, Some((id.as_str(), studio.as_path()))),
    ]);

    /* What you told every card once instead of every turn — the wall's standing
       instructions and this card's territory's, composed. Read from the store
       here for the fourth time and the fourth iteration of the same argument;
       `crate::guidance` has why it is the system prompt rather than a hook or a
       CLAUDE.md, and why a card already running does not hear an edit.

       A chat card gets this too. Its territory is the sentinel one chat cards
       share and says nothing, but the wall's instructions are facts about the
       person at the keyboard and do not stop being true because a card has no
       repository in front of it. */
    let standing =
        crate::guidance::for_conversation(&app.state::<crate::store::Store>(), &id);

    /* What this card knows about itself, asked of the store for the fifth time
       and the fifth iteration of the same argument (`kind_of`, `setup_of`,
       `worktree_of`, `gear_of`, and now this). It could not travel as an
       argument even if anyone wanted it to: the caller that would have to
       remember is `wake`, and a card roused at launch is exactly the one that
       has forgotten who opened it.

       Derived at every spawn rather than once at birth, which is what makes it
       reach the cards already on the wall: a spawn is also every wake, so a card
       opened last month is told its parentage again the next time it is roused.
       That answers the cost `be79bb41` records against this shape — "only
       reaches cards spawned after the change" is true of a *birth*-time fact and
       not of one derived here. */
    let me = Selfhood {
        handle: crate::relay::handle_of(&id),
        spawned_by: crate::store::provenance_of(&app.state::<crate::store::Store>(), &id),
    };

    /* And the same fact where a shell command can reach it without asking
       anybody. `CLAUDE.md` sends working files to `.scratch-<your card handle>/`
       and a card that has to call a tool to learn the name is a card that writes
       to `.scratch/` instead — which is swept, shared, and has already cost a
       rebuilt measurement harness (sink f1e1a8a2). `.scratch-$SKEIN_CARD` cannot
       be got wrong.

       Set for a chat card too, where it is inert: it has no Bash tool to expand
       it with. Setting it unconditionally is one line where a condition is one
       line and a case to be wrong about. */
    cmd.env("SKEIN_CARD", &me.handle);

    /* Where the wall's shared browser is, for a card that wants to drive one.
       `browser.rs` owns a real Chrome with a CDP port; this is the address a
       test can hand to `chromium.connectOverCDP` so the page it drives is the
       page the browser widget is showing — same browser, same session, same
       login, and the person can take the mouse mid-run.

       An environment variable rather than a tool, because the thing that needs
       it is *test code the agent writes*, not the agent itself: `connectOverCDP`
       takes a string, and a string in the environment is one a shell expansion
       reaches without a round trip. Same argument as `SKEIN_CARD` one line up.

       Set only while a browser is actually running, and that is the whole
       reason it is `Option`: an empty variable would read as an endpoint to a
       card checking whether the variable exists, and it would connect to
       nothing. A card spawned before the browser started does not have it —
       which is honest, since at that moment there was nowhere to connect. */
    if let Some(endpoint) = crate::browser::endpoint(app) {
        cmd.env("VOLERY_CDP_ENDPOINT", endpoint);
    }

    /* Which subscription this card spends. `CLAUDE_SECURESTORAGE_CONFIG_DIR`
       selects the credential store and *only* the store — `CLAUDE_CONFIG_DIR`
       is untouched, so the transcript still lands in the shared config
       directory and the `--resume` an account swap is built on works exactly as
       before. Probed 2026-08-20 against claude 2.1.235: an empty store dir
       reports `loggedIn: false, authMethod: "none"`, so there is no quiet
       fall-through to the global sign-in; a store holding a credential reports
       `authMethod: "claude.ai"` with the account's own email and plan; and a
       real turn ran under one while writing its transcript to the usual place.

       Per-process, so two cards can be on two accounts at the same moment, and
       the store's own refresh is the CLI's business rather than ours — which is
       the half `CLAUDE_CODE_OAUTH_TOKEN` could not do, since a token put in the
       environment carries no refresh token and cannot heal when it expires.

       This was that token, and the reason it changed is in `accounts.rs`: a
       `setup-token` credential is scoped `user:inference` alone, so the
       allowance endpoint refused it and a card's account could never be
       measured. See `.claude/rules/accounts.md`.

       None means the account Claude Code is signed in as, which is every card
       that existed before accounts did and every wall with none registered.

       A label whose store holds no credential is a hard failure rather than a
       silent fall-through to the signed-in account: falling through would spend
       the wrong subscription — quietly, and precisely the one being held in
       reserve. */
    if let Some(label) = account_label.as_deref().filter(|s| !s.is_empty()) {
        if !crate::accounts::signed_in(&app, label) {
            return Err(format!(
                "'{label}' is not signed in — sign in to it in the accounts panel"
            ));
        }
        let dir = crate::accounts::store_dir(&app, label)?;
        cmd.env("CLAUDE_SECURESTORAGE_CONFIG_DIR", &dir);
        /* Cleared rather than left alone: the CLI reads this ahead of any
           store, so one inherited from Skein's own environment would quietly
           outrank the account this card was put on. */
        cmd.env_remove("CLAUDE_CODE_OAUTH_TOKEN");
    }

    /* A path we cannot even build is one we cannot find a transcript at, which
       is the same answer as there not being one: start fresh.

       Asked of `run_dir` rather than of `cwd`, because the CLI files a
       transcript under the directory it is *running* in — a worktree card's
       transcripts are under the tree's own slug, not the project root's. Asking
       the wrong one would answer "no transcript" for a card that has been
       talking for days, and a card that starts fresh every time it wakes is one
       that has quietly lost its memory. */
    if run_dir != cwd {
        reunite_split_transcript(app, &cwd, &run_dir, session);
    }
    let resume = transcript_path(&app, &run_dir, session).is_ok_and(|p| p.exists());
    if resume {
        cmd.args(["--resume", session]);
    } else {
        cmd.args(["--session-id", session]);
    }
    if let Some(m) = model.as_deref().filter(|m| !m.trim().is_empty()) {
        cmd.args(["--model", m]);
    }
    /* `--effort <level>`, the five the CLI names. Passed on every spawn rather
       than only the first: `/effort` says "this session only", so a resumed
       session would otherwise come back at the configured default having been
       set to something else — and the level in the row is the one the card was
       last seen thinking at, written there by `#adoptEffort`. */
    if let Some(e) = effort.as_deref().filter(|e| !e.trim().is_empty()) {
        cmd.args(["--effort", e]);
    }

    /* Hand the agent a way to ask us something. The URL carries the
       conversation id, so a call arrives already addressed to a card. */
    let ask_port = app.state::<crate::ask::Asks>().port();
    if ask_port != 0 {
        let cfg = crate::ask::mcp_config(ask_port, &id);
        cmd.args(["--mcp-config", &cfg.to_string()]);
        /* Or the CLI abandons the parked call after one minute and the click
           lands on a request nobody is reading. This moves the *hard* deadline
           only; the config above carries the same number again for the idle
           watchdog, which no variable here reaches — see ask::mcp_config. */
        cmd.env("MCP_TOOL_TIMEOUT", crate::ask::client_timeout_ms().to_string());
    }

    /* **One flag, or one of them is silently thrown away.** This used to be two
       `--append-system-prompt` arguments — the standing instructions above and
       the roster paragraph in the block just past — and the CLI keeps only the
       last occurrence, so the person's own instructions never reached a single
       card that had an ask server. Reported from inside one (sink a88048d9) with
       both scopes set in the store and no `# Standing instructions` block in its
       prompt, and confirmed the same way: a card spawned by this wall could read
       the roster paragraph in its own prompt and not the wall's guidance.

       Nothing said so, and nothing could. `tools/probe-guidance.ts` proved the
       flag lands and survives `--resume`, which is true and was never the
       question — it passes *one*. The two call sites were far apart in this
       function and each was locally correct. `system_prompt` is the seam, so
       there is now one place that can be wrong and a test that reads it.

       Note the shape of what shipped: the guidance was dropped exactly when the
       ask server was up, which is always, so the feature was inert rather than
       flaky. A conditional second flag is worse than an unconditional one — it
       looks like it works in the one configuration nobody runs. */
    if let Some(text) = system_prompt(chat, ask_port != 0, standing, Some(&me)) {
        cmd.args(["--append-system-prompt", &text]);
    }

    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not start claude in {cwd}: {e}"))?;

    /* Before anything is taken off the child, so the tree is enclosed from its
       first breath — an MCP server spawned between here and the insert below
       would otherwise be outside the job for the rest of its life. */
    let job = crate::servers::jobs::Job::new();
    if let Some(j) = &job {
        j.assign(child.id());
    }

    let stdout = child.stdout.take().ok_or("no stdout on child")?;
    let stderr = child.stderr.take().ok_or("no stderr on child")?;
    let stdin = child.stdin.take().ok_or("no stdin on child")?;

    let turn = Arc::new(AtomicBool::new(false));
    /* Minted before the reader thread is given it, so the thread and the map
       entry below are stamped with the same number. */
    let generation = GENERATION.fetch_add(1, Ordering::Relaxed);

    // stdout: one JSON object per line. Anything unparseable is surfaced rather
    // than swallowed — a silent drop here would be very hard to debug later.
    {
        let app = app.clone();
        let id = id.clone();
        let turn = turn.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if line.trim().is_empty() {
                    continue;
                }
                match serde_json::from_str::<serde_json::Value>(&line) {
                    Ok(event) => {
                        /* Read before the value is handed over, since the emit
                           takes it. Cheap next to the parse above and the hop
                           into the webview below. */
                        if let Some(open) = event
                            .get("type")
                            .and_then(|t| t.as_str())
                            .and_then(turn_mark)
                        {
                            /* Only when it actually changes: `stream_event`
                               arrives thousands of times a turn and every one
                               of them says "open", while the row only wants
                               telling at the two boundaries. */
                            if turn.swap(open, Ordering::Relaxed) != open {
                                persist_turn(&app, &id, open);
                            }
                        }
                        let _ = app.emit(
                            "conv:event",
                            ConvEvent {
                                id: id.clone(),
                                event,
                            },
                        );
                    }
                    Err(_) => {
                        let _ = app.emit(
                            "conv:stderr",
                            ConvLine {
                                id: id.clone(),
                                line,
                            },
                        );
                    }
                }
            }
            /* stdout closing is the reliable signal that the child is finished,
               so this is where it gets reaped. Two things depend on that:

               1. The id has to leave the map, or `spawn_conversation` keeps
                  answering "already open" for a process that is dead. `wake`
                  reads that as "it is awake after all", clears `dormant`, and
                  the next `send_prompt` writes into a closed pipe — for good.
                  A card whose agent crashed could never be revived, only closed.

               2. The exit code only exists once somebody waits. Emitting `None`
                  here meant `markExited` always took its clean-exit branch, so a
                  `claude` that died on its own reported as "dormant" and the
                  reason sat unread in the stderr lines. */
            /* The stream is over, so no turn is open on it any more — a child
               that died holding one is gone rather than interrupted, and the
               card is about to say so through `markExited`. The row is told the
               same thing, so tomorrow's launch does not resume a turn whose
               failure you were shown today.
               Unless the app is the one ending the stream, which is the whole
               case the mark exists for: killing every child is how quitting
               works, and a clear here would undo the flag on the way out. */
            turn.store(false, Ordering::Relaxed);
            if !app.state::<Supervisor>().going_away() {
                persist_turn(&app, &id, false);
            }
            /* By generation as well as by id: if this stream ended because
               `close_conversation` killed it and the card has since been given
               a new process, the entry under this id belongs to that one and
               must be left alone. `reap` answers `None` either way — a child
               already removed by a deliberate close, and one superseded, are
               both "nothing of ours left to reap". */
            let code = app.state::<Supervisor>().reap(&id, generation);
            let _ = app.emit("conv:exit", ConvExit { id, code });
        });
    }

    {
        let app = app.clone();
        let id = id.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if line.trim().is_empty() {
                    continue;
                }
                let _ = app.emit(
                    "conv:stderr",
                    ConvLine {
                        id: id.clone(),
                        line,
                    },
                );
            }
        });
    }

    sup.0
        .lock()
        .unwrap()
        .insert(id.clone(), Conv { child, stdin, turn, job, fleet: None, generation });

    /* Its post. Asked for here rather than at either call site for the reason
       `kind` is read here: `wake` and `open` both reach this line and only one
       of them would have remembered. Before anything else can be written to the
       card, so a wake caused by a prompt you typed still reads what it was told
       while it slept first — which is the order the two actually happened in. */
    crate::relay::drain_inbox(&app, &id);
    Ok(())
}

/// What one event off the wire says about whether a turn is open on this child.
///
/// `Some(true)` a turn is running, `Some(false)` it has settled, `None` this
/// event says nothing either way. It is the whole of the wire vocabulary Rust
/// knows — `classify.ts` owns the rest and should go on owning it — and it is
/// here rather than there because both places that read the answer are here: the
/// row is written as the turn turns over (`persist_turn`), on a thread that has
/// no webview to ask, and the answer is wanted again at `ExitRequested`, when
/// there is no round trip left to make.
///
/// `system` is deliberately absent: `system/init` arrives on every spawn,
/// including the ones rousing makes with nothing to say, and a spawn is not a
/// turn. Speech is what opens one, whoever started it — a prompt of yours, the
/// rousing queue's, or the `<task-notification>` the CLI injects when a
/// background job lands, which wakes the agent with no `send_prompt` anywhere
/// near it — measured, 48 times in 53, at a median of ten seconds. The
/// exception is the notification a *restart* produces, reconciling tasks it
/// found orphaned, which wakes nobody; see `turns.md`, "told, and not
/// stirring".
fn turn_mark(kind: &str) -> Option<bool> {
    match kind {
        "result" => Some(false),
        "assistant" | "user" | "stream_event" => Some(true),
        _ => None,
    }
}

/// Write the turn mark through to the card's row.
///
/// The flag used to be worked out at `ExitRequested` and written once, which
/// made it mean "the app was asked to close mid-turn" rather than "this turn was
/// lost" — and a crash asks nothing. So the wall came back from the one exit
/// that really does lose work with nothing to resume. Written here, the row is
/// already true before anything goes wrong; see `store::set_mid_turn`.
///
/// Best-effort by design. This runs on a reader thread and on the send path, and
/// a card whose mark did not land is a resume prompt not offered — never a wrong
/// one sent — so there is nothing here worth failing a turn over.
fn persist_turn(app: &AppHandle, id: &str, open: bool) {
    if let Some(store) = app.try_state::<crate::store::Store>() {
        if let Ok(conn) = store.0.lock() {
            crate::store::set_mid_turn(&conn, id, open);
        }
    }
    /* The one place both boundaries of a turn already go through, which is why
       the relay's chain mark is cleared from here rather than from the reader
       thread — a second site watching for the same transition is a second site
       to get the `stream_event` storm wrong. */
    if !open {
        crate::relay::turn_closed(app, id);
        /* And the same argument again, from the other end: telling a parent its
           child has stopped needs exactly this transition and nothing else, so
           it is folded here rather than watched for anywhere. `spawn.rs` has why
           a stop is not the same fact as a rest. */
        crate::spawn::settling(app, id);
    } else {
        crate::spawn::stirring(id);
    }
}

/// Put a message into a card's stdin without it being something you typed.
///
/// `send_prompt` minus the echo, and the difference is the whole point: the
/// pending/claimed machinery in `Conversation.echo` exists to say whether the
/// process has got *your* draft yet, and there is no draft here. What arrives
/// back is a plain `user` replay with nothing waiting to claim it, which the
/// front end already handles — it is the "a prompt this window did not send"
/// path, and `relay::RELAY_MARK` is what tells it whose.
///
/// Errs when the card has no process. That is not a failure: it is the answer
/// `do_send` turns into a queued row, so a dormant card is written to rather
/// than woken.
pub fn deliver(app: &AppHandle, id: &str, text: &str) -> Result<(), String> {
    {
        let sup = app.state::<Supervisor>();
        let mut map = sup.0.lock().unwrap();
        let conv = map.get_mut(id).ok_or("that card is dormant")?;
        let msg = serde_json::json!({
            "type": "user",
            "message": { "role": "user", "content": [{ "type": "text", "text": text }] }
        });
        writeln!(conv.stdin, "{msg}").map_err(|e| format!("write to claude stdin: {e}"))?;
        conv.stdin.flush().map_err(|e| format!("flush claude stdin: {e}"))?;
        conv.turn.store(true, Ordering::Relaxed);
    }
    /* Outside the map's lock, per the note in `send_prompt`. */
    persist_turn(app, id, true);
    Ok(())
}

/// Send one user turn. The wire format is the same envelope the Agent SDK uses.
///
/// `async`, through `off_main`, because a pipe write is not the instant thing it
/// looks like. The child's stdin buffer is finite — 64KB by default on Windows
/// — and a `claude` that has stopped draining it makes this park *holding the
/// supervisor's mutex*, on the main thread. That is not a slow send: it is every
/// card on the wall unpainted, and `interrupt_conversation` unable to take the
/// lock, so the one gesture that could have unwedged it is the one that cannot
/// get through. See `crate::off_main`.
#[tauri::command]
pub async fn send_prompt(app: AppHandle, id: String, text: String) -> Result<(), String> {
    crate::off_main(move || {
        {
            let sup = app.state::<Supervisor>();
            let mut map = sup.0.lock().unwrap();
            let conv = map
                .get_mut(&id)
                .ok_or_else(|| format!("no open conversation {id}"))?;

            let msg = serde_json::json!({
                "type": "user",
                "message": { "role": "user", "content": [{ "type": "text", "text": text }] }
            });

            writeln!(conv.stdin, "{msg}").map_err(|e| format!("write to claude stdin: {e}"))?;
            conv.stdin
                .flush()
                .map_err(|e| format!("flush claude stdin: {e}"))?;
            /* Marked here rather than waiting for the echo to come back: a prompt
               that is on the wire and unanswered when the app closes is exactly a
               lost turn, and the window between the write and the first event is
               where a quit that feels instantaneous lands. */
            conv.turn.store(true, Ordering::Relaxed);
        }
        /* Outside the map's lock, which is the only ordering rule the two mutexes
           have: nothing takes the store's lock and then the supervisor's, so nothing
           here can be half of a cycle. */
        persist_turn(&app, &id, true);
        Ok(())
    })
    .await?
}

/// Stop the turn a conversation is in the middle of, without ending it.
///
/// The stdin that carries prompts carries a second kind of message: a
/// `control_request`. The CLI accepts a small set of subtypes on it — the
/// binary's dispatcher lists `interrupt`, `set_model`, `set_permission_mode`,
/// `set_max_thinking_tokens`, `set_color`, `mcp_toggle`, `message_rated` — and
/// `interrupt` is the same one the Agent SDK's `query.interrupt()` sends.
///
/// Probed against claude 2.1.229 with `tools/probe-interrupt.ts`, which spawns
/// with Skein's exact argv. Writing the line below produced, inside 20ms:
///
/// ```text
/// control_response  subtype success, {still_queued: [], cancelled: []}
/// assistant         the half-written answer, as far as it had got
/// user              "[Request interrupted by user]"
/// result            is_error true, terminal_reason "aborted_streaming"
/// ```
///
/// and then the child stayed up and answered the next prompt normally. That is
/// the whole point: this is not `close_conversation` with a nicer name. The
/// process, the session and the context all survive — only the turn ends.
///
/// `cancel_queued` is deliberately not asked for, though the CLI advertises it
/// (`interrupt_cancel_queued_v1`). Stopping means stopping what is *running*: a
/// prompt already written to stdin behind it is one you sent and are owed an
/// answer to, and the transcript is marking it unacknowledged until it lands.
/// Cancelling it here would settle that mark with nothing to settle it with.
/// `async` for `send_prompt`'s reason, and one more of its own: this shares the
/// supervisor's mutex with every other command here, so leaving it on the main
/// thread would park it there waiting for a lock a slow write is holding.
/// **A command sharing a mutex with a blocking one has to leave the main thread
/// too** — the rule `release_azdo` records, and Escape is the worst possible
/// gesture to have queued behind a wedged card.
#[tauri::command]
pub async fn interrupt_conversation(app: AppHandle, id: String) -> Result<(), String> {
    crate::off_main(move || {
        let sup = app.state::<Supervisor>();
        let mut map = sup.0.lock().unwrap();
        let conv = map
            .get_mut(&id)
            .ok_or_else(|| format!("no open conversation {id}"))?;

        /* Nothing here correlates the receipt, but two interrupts in flight under
           one id would make the pair on the wire unreadable to anything that did. */
        let n = INTERRUPTS.fetch_add(1, Ordering::Relaxed);
        let msg = serde_json::json!({
            "type": "control_request",
            "request_id": format!("skein-interrupt-{n}"),
            "request": { "subtype": "interrupt" }
        });

        writeln!(conv.stdin, "{msg}").map_err(|e| format!("write to claude stdin: {e}"))?;
        conv.stdin
            .flush()
            .map_err(|e| format!("flush claude stdin: {e}"))
    })
    .await?
}

static INTERRUPTS: AtomicU64 = AtomicU64::new(0);

/// Put a conversation into a different permission mode, without ending it.
///
/// The second gear the wall has ever had. Every project card spawns with
/// `--dangerously-skip-permissions` and has the machine from its first turn;
/// this is how one is set to *plan* instead — reading, searching and thinking,
/// with no tool that can change the repository — and how it is set back.
///
/// **Probed before it was built** (claude 2.1.241, `tools/probe-plan.ts`), and
/// two of the three answers were not what the design assumed:
///
/// ```text
/// --> set_permission_mode plan          (on a card spawned with bypass)
///     control_response  success, {"mode":"plan"}
///     system/init       permissionMode=plan   tools=29     <- was 59
///     ...asked to write a file: wrote a PLAN instead, to ~/.claude/plans/
/// --> set_permission_mode acceptEdits
///     system/init       permissionMode=acceptEdits  tools=59
///     ...asked again: wrote the file
/// ```
///
/// 1. **It beats the bypass flag.** A card spawned
///    `--dangerously-skip-permissions` and then asked for `plan` really loses
///    its writing tools. That is what makes this a gear rather than a kind of
///    card: no respawn, no lost process, no second conversation, and the context
///    the planning was done in is the context that executes it.
/// 2. **Two events carry the mode and one of them can be stale.** The
///    `control_response` above is the immediate, authoritative one: it lands in
///    ~60ms carrying the new mode, and it is what the front end really folds.
///    `system/init` also carries `permissionMode`, but it is emitted **per
///    turn** and reports the mode that turn is running *under* — a turn already
///    in flight names the old one. Measured: acknowledged `plan` at 15.13s,
///    then an init at 17.76s still saying `bypassPermissions`. So nothing here
///    has to tell the front end what it just did, but `gears.ts` does have to
///    decide which of the two to believe, and does.
/// 3. **`ExitPlanMode` is gone.** 2.1.241's plan mode writes a document to
///    `~/.claude/plans/` rather than parking a tool call for approval, so none
///    of `ask.rs` is involved and there is nothing to resume.
///
/// The mode is written to the store *before* the wire, and that order is the
/// point: a card whose gear did not survive a rouse would be a card that comes
/// back holding the machine because nobody remembered it had been put down.
/// Same lesson as `store::setup_of` — see the note in `spawn`.
///
/// **Persisted even when there is no process**, which is the case a dormant card
/// is in. Setting the gear on a dormant card is a decision about that card, and
/// it is honoured the moment it wakes, by `spawn`.
///
/// `async` for `interrupt_conversation`'s reason: this shares the supervisor's
/// mutex with every other command here, so leaving it on the main thread would
/// park it there waiting for a lock a slow write is holding.
#[tauri::command]
pub async fn set_permission_mode(app: AppHandle, id: String, mode: String) -> Result<(), String> {
    /* The wall's two, and the CLI's wider set, both allowed through: Volery
       offers two gears but the column is the CLI's vocabulary, so a mode this
       build has no reading for is still a mode this build can be *put* into.
       Rejected rather than passed through blind, because an unknown value on
       `--permission-mode` is a card that fails to spawn at all, for ever, with
       the reason in a stderr line nobody reads. */
    const KNOWN: [&str; 6] = [
        "plan",
        "acceptEdits",
        "auto",
        "bypassPermissions",
        "manual",
        "dontAsk",
    ];
    if !KNOWN.contains(&mode.as_str()) {
        return Err(format!("not a permission mode: {mode}"));
    }

    crate::off_main(move || {
        crate::store::set_permission_mode(&app.state::<crate::store::Store>(), &id, &mode)?;

        let sup = app.state::<Supervisor>();
        let mut map = sup.0.lock().unwrap();
        /* A dormant card has no process and that is not a failure: the gear is
           stored, and `spawn` reads it when the card wakes. */
        let Some(conv) = map.get_mut(&id) else {
            return Ok(());
        };

        let n = GEAR_CHANGES.fetch_add(1, Ordering::Relaxed);
        let msg = serde_json::json!({
            "type": "control_request",
            "request_id": format!("skein-mode-{n}"),
            "request": { "subtype": "set_permission_mode", "mode": mode }
        });
        writeln!(conv.stdin, "{msg}").map_err(|e| format!("write to claude stdin: {e}"))?;
        conv.stdin
            .flush()
            .map_err(|e| format!("flush claude stdin: {e}"))
    })
    .await?
}

static GEAR_CHANGES: AtomicU64 = AtomicU64::new(0);

/// How Claude Code names a transcript directory: every character that is not
/// ASCII alphanumeric becomes a dash. `C:\atelier\skein` → `C--atelier-skein`.
///
/// It is *not* only the separators, which is what this used to assume. Probed
/// against claude 2.1.228 by spawning in three directories and reading back the
/// name it created under `~/.claude/projects`:
///
/// ```text
/// slug_probe a.b+c → slug-probe-a-b-c     (_, space, ., + all fold)
/// café_naïve-Ω9    → caf--na-ve--9        (non-ASCII folds too)
/// emoji🌿probe     → emoji--probe         (one emoji, two dashes)
/// ```
///
/// So it is `is_ascii_alphanumeric`, not `is_alphanumeric` — the latter would
/// keep the `é` and miss the directory entirely. And the replacement runs per
/// UTF-16 code unit, so an astral char yields two dashes rather than one.
///
/// The dot is the one that bit: `C:\atelier\skein\.scratch\wall` resolved to a
/// path that does not exist, `read_ai_title` read that as "no transcript yet"
/// — its normal, silent case — and every conversation under a dotted directory
/// went permanently untitled.
fn fold_dir_name(cwd: &str) -> String {
    let mut out = String::with_capacity(cwd.len());
    for c in cwd.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else {
            for _ in 0..c.len_utf16() {
                out.push('-');
            }
        }
    }
    out
}

/// The same fold, over the path **the child will actually report** — which is
/// not always the path we spawn it with, and that gap cost two territories
/// every one of their conversations.
///
/// `C:\Users\lyss` on this machine is a junction to `C:\Users\flori`. Windows
/// resolves a reparse point when a process's current directory is *opened*, so
/// a child spawned with `current_dir("C:\Users\lyss\codes\rise")` reports
/// `C:\Users\flori\codes\rise` from `process.cwd()` and files its transcript
/// under `C--Users-flori-codes-rise`. Probed 2026-08-26 — `bun -e
/// "console.log(process.cwd())"` from the junction path answers the target, and
/// there is not one `C--Users-lyss-…` directory under `~/.claude/projects`
/// against 17 cards whose rows say that is where they live. Note `cmd`'s own
/// `cd` answers the junction path, because a shell tracks its directory as a
/// string; a real spawn does not, and a real spawn is what this is about.
///
/// So both sides asked the same question and got different answers. The CLI
/// refuses `--session-id` for a session it already has a transcript for
/// (`Own()` in the bundled JS, a `statSync` of exactly this path), and Skein
/// chooses between `--session-id` and `--resume` by asking whether that file is
/// there — from the unresolved path, where it never was. So every card under
/// `nova` and `rise` spawned fresh, and the first wake after it had spoken died
/// on `Error: Session ID … is already in use.`, exit 1, before a turn: the
/// account waterfall's close-and-respawn was where it showed, since that is the
/// one path that wakes a card seconds after it spoke.
///
/// Falls back to the string it was given when the path cannot be resolved,
/// which is a directory that is not there — the same answer as before, and the
/// same "no transcript" every caller already handles.
pub(crate) fn transcript_dir_name(cwd: &str) -> String {
    fold_dir_name(&real_dir(cwd))
}

/// A path as the filesystem itself spells it: junctions and symlinks followed,
/// case as the directories really are.
fn real_dir(cwd: &str) -> String {
    match std::fs::canonicalize(cwd) {
        Ok(p) => plain(&p.to_string_lossy()),
        // Not there — nothing to resolve, and nothing to file under either.
        Err(_) => cwd.to_string(),
    }
}

/// Take the verbatim prefix off what `canonicalize` hands back on Windows.
///
/// `\\?\C:\x` is the same directory as `C:\x` and folds to a different slug, so
/// leaving it on would trade this bug for the identical one. The UNC form needs
/// its own arm: `\\?\UNC\server\share` is `\\server\share`, and stripping only
/// `\\?\` would leave a literal `UNC` in the middle of the path.
fn plain(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    path.strip_prefix(r"\\?\").unwrap_or(path).to_string()
}

/// Where Claude Code keeps this session's transcript.
///
/// Note which way this is used: to *read* a session we already know the id of.
/// Going the other way — deciding which sessions exist — must not decode this
/// name, because the encoding is lossy (`.scratch` and `-scratch` collide). Ask
/// the records instead; every one of them carries its own `cwd`.
///
/// **`cwd` here means the directory the child *runs* in**, which for a worktree
/// card is not the `cwd` on its row. The CLI files a session under whichever
/// directory it was started in, so this is the one question where the tree wins
/// over the territory — `store::session_of` folds the two and is what every
/// caller outside this module should be asking.
pub(crate) fn transcript_path(app: &AppHandle, cwd: &str, session_id: &str) -> Result<PathBuf, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("no home dir: {e}"))?;
    Ok(home
        .join(".claude")
        .join("projects")
        .join(transcript_dir_name(cwd))
        .join(format!("{session_id}.jsonl")))
}

/// Put back together a worktree card whose history got split in two.
///
/// **A transcript under the project root's slug, for the session of a card that
/// works in a tree, is the fingerprint of one bug and nothing else.** That
/// card's child has never once been meant to run there, so the file can only
/// have been written by a build that spawned it in the wrong directory — every
/// build before `worktree_of`, on every wake, account swap and rouse. The cards
/// this was found on had two transcripts apiece under one session id, split at
/// the first wake and not overlapping by a single record: the tree holding the
/// first stretch and the root everything since, up to 1,697 records and a full
/// day of work in the half the tree does not have.
///
/// So the fix on its own would have *rewound* those cards — sending the child
/// back to the tree, where the older half is what `--resume` finds. The newer
/// half is moved to where the card now looks, and the older is kept beside it
/// as `.jsonl.bak`: nothing is deleted, and `.bak` rather than `.jsonl` because
/// `sessions::walk` reads any `.jsonl` stem as a session id, and a half a card
/// could adopt but never resume is worse than one it cannot see.
///
/// Runs at the one safe moment — a spawn, where this card has no process — and
/// only ever moves the newer file onto the older, so the second call finds
/// nothing to do. Best effort throughout: every failure leaves both files
/// exactly where they were, which is the state this is an improvement on rather
/// than a departure from.
fn reunite_split_transcript(app: &AppHandle, cwd: &str, run_dir: &str, session: &str) {
    let (Ok(stray), Ok(ours)) = (
        transcript_path(app, cwd, session),
        transcript_path(app, run_dir, session),
    ) else {
        return;
    };
    let Ok(stray_at) = stray.metadata().and_then(|m| m.modified()) else {
        // No file under the root slug: the ordinary case, and nothing to mend.
        return;
    };
    /* Newer, or there is nothing here at all. The comparison is what keeps this
       from ever running backwards — a card mended once has its recent half in
       the tree, and the root copy left behind is older from then on. */
    match ours.metadata().and_then(|m| m.modified()) {
        Ok(ours_at) if ours_at >= stray_at => return,
        Ok(_) => {
            /* A free name, never an occupied one. `fs::rename` on Windows
               replaces silently, and the one thing this must not do while
               claiming to keep both halves is write over a half it kept
               earlier. */
            let Some(kept) = (1..99)
                .map(|n| match n {
                    1 => ours.with_extension("jsonl.bak"),
                    n => ours.with_extension(format!("jsonl.bak{n}")),
                })
                .find(|p| !p.exists())
            else {
                return;
            };
            if std::fs::rename(&ours, &kept).is_err() {
                return;
            }
        }
        Err(_) => {}
    }
    let _ = std::fs::rename(&stray, &ours);
}

/// Where *this card's* transcript is, asked of the store.
///
/// The three reads below all used to take a `cwd` and a `session_id` from the
/// front end, which had both to hand and passed them faithfully — and for a
/// worktree card the first of them was the wrong directory, because the row's
/// `cwd` is the territory and the CLI files under the tree. So the panel of a
/// card working on a branch read a transcript that was not its own: empty
/// before the card had ever been woken in the main tree, and the *wrong half*
/// of a split history afterwards.
///
/// One id in, one path out, and the pair is folded in the one place that holds
/// both facts — `store::session_of`. Two travelling arguments cannot disagree
/// with the row if there are no travelling arguments.
///
/// `None` for a card with no row at all, which is the same silent case a
/// missing file already is: nothing to read, and nothing to complain about.
fn card_transcript(app: &AppHandle, id: &str) -> Result<Option<PathBuf>, String> {
    let Some(store) = app.try_state::<crate::store::Store>() else {
        return Ok(None);
    };
    let found = {
        let Ok(conn) = store.0.lock() else {
            return Ok(None);
        };
        crate::store::session_of(&conn, id)
    };
    let Some((run_dir, session)) = found else {
        return Ok(None);
    };
    /* The row carries the id in `agent_session_id` from the insert, so the
       fallback is belt and braces — and it is the same fallback the front end
       applied when it was the one passing this down (`agent_session_id || id`),
       kept so a row written by some older build behaves as it always did. */
    let session = session.unwrap_or_else(|| id.to_string());
    transcript_path(app, &run_dir, &session).map(Some)
}

/// The conversation as Claude Code recorded it, for the front end to fold.
#[derive(Serialize)]
pub struct Transcript {
    text: String,
    /// Bytes skipped off the front because the file was over the cap. Non-zero
    /// means the reader handed back a tail, and the card should say so.
    dropped_bytes: u64,
}

/// Read a session's transcript off disk.
///
/// This is the only way to see anything that happened before Skein attached:
/// `--resume` replays nothing onto the stream. Probed against claude 2.1.228 —
/// resuming a two-turn session with `--output-format stream-json` produced
/// `system/init`, the new prompt and the new answer, and no historical
/// messages at all. The model had the history (it answered from it); stdout
/// never carried it. The TUI's scrollback is this file, rendered locally.
///
/// The tail is what matters when a transcript is large — the biggest here is
/// 4 MB — so an over-cap file is read from the end, and the partial line the
/// seek lands in the middle of is discarded.
///
/// Off the main thread, via `crate::off_main`: up to eight megabytes read and
/// folded, and every rouse on the wall asks for one. On the main thread a wall
/// coming back was a stall per card, each one holding up the paint of the rest.
#[tauri::command]
pub async fn read_transcript(
    app: AppHandle,
    id: String,
    max_bytes: Option<u64>,
) -> Result<Option<Transcript>, String> {
    crate::off_main(move || transcript_of(&app, id, max_bytes)).await?
}

/// The read itself, apart from the command that carries it.
fn transcript_of(
    app: &AppHandle,
    id: String,
    max_bytes: Option<u64>,
) -> Result<Option<Transcript>, String> {
    /* Enough for any transcript on this machine, and a bound rather than a
       promise: 8 MB of NDJSON folds to a few thousand lines, of which the front
       end keeps the last few hundred. */
    const DEFAULT_CAP: u64 = 8 * 1024 * 1024;
    let cap = max_bytes.unwrap_or(DEFAULT_CAP).max(1);

    // A card that was never spoken to has no transcript. Normal, not an error.
    let Some(path) = card_transcript(app, &id)? else {
        return Ok(None);
    };
    let Ok(mut file) = File::open(&path) else {
        return Ok(None);
    };
    let len = file
        .metadata()
        .map_err(|e| format!("stat transcript: {e}"))?
        .len();

    let dropped_bytes = len.saturating_sub(cap);
    if dropped_bytes > 0 {
        file.seek(SeekFrom::Start(dropped_bytes))
            .map_err(|e| format!("seek transcript: {e}"))?;
    }
    let mut buf = Vec::with_capacity(len.min(cap) as usize);
    file.read_to_end(&mut buf)
        .map_err(|e| format!("read transcript: {e}"))?;

    /* Lossy on purpose: seeking to a byte offset can land inside a multi-byte
       char, and that char is in the partial line we are about to drop anyway. */
    let mut text = String::from_utf8_lossy(&buf).into_owned();
    if dropped_bytes > 0 {
        match text.find('\n') {
            Some(i) => text.drain(..=i),
            None => text.drain(..),
        };
    }

    Ok(Some(Transcript {
        text,
        dropped_bytes,
    }))
}

/// The title Claude Code generated for this session.
///
/// It is written to the transcript file but *not* emitted on the stream — the
/// event types on the wire are system / stream_event / assistant / user /
/// result / rate_limit_event, and `ai-title` is not among them. So the only way
/// to get a real name onto a card is to read it off disk.
///
/// Off the main thread, via `crate::off_main`: this reads the whole transcript
/// into memory — the comment below says multi-megabyte, and means it — and the
/// wall asks it once per card while naming them.
#[tauri::command]
pub async fn read_ai_title(app: AppHandle, id: String) -> Result<Option<String>, String> {
    crate::off_main(move || ai_title_of(&app, id)).await?
}

/// The read itself, apart from the command that carries it.
fn ai_title_of(app: &AppHandle, id: String) -> Result<Option<String>, String> {
    // No transcript yet is normal, not an error.
    let Some(path) = card_transcript(app, &id)? else {
        return Ok(None);
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Ok(None);
    };

    /* The record repeats as the title is refined, so the last one wins. A
       cheap substring test first keeps this from parsing every line of a
       multi-megabyte transcript. */
    let mut found = None;
    for line in text.lines() {
        if !line.contains("\"ai-title\"") {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            if v.get("type").and_then(|t| t.as_str()) == Some("ai-title") {
                if let Some(t) = v.get("aiTitle").and_then(|t| t.as_str()) {
                    if !t.trim().is_empty() {
                        found = Some(t.to_string());
                    }
                }
            }
        }
    }
    Ok(found)
}

/// How far back the effort read looks to begin with.
///
/// A quarter of a megabyte. Every `assistant` record carries the field, so what
/// this has to clear is only the distance from EOF back past the bookkeeping the
/// CLI writes after a turn (`ai-title`, `last-prompt`) and whatever tool results
/// came after the last thing the agent said — which is where the distance
/// actually varies, since one `Read` of a large file is megabytes of `user`
/// record between two speeches.
const EFFORT_TAIL_FROM: u64 = 256 * 1024;

/// How far back it will go before answering "not recorded".
///
/// Same eight megabytes `relay.rs` settles on for the same reason: a card whose
/// last speech is further back than that has spent millions of characters of
/// tool output since, and reading the whole file to label a footer is not worth
/// what it costs on a path that runs at every settling turn.
const EFFORT_TAIL_MAX: u64 = 8 * 1024 * 1024;

/// How hard this session has been told to think, out of the transcript on disk.
///
/// **The wire does not carry this.** Probed 2026-08-20 against claude 2.1.233,
/// spawning with Skein's exact argv: `system/init` names the model, the tools,
/// the slash commands, the output style and the version, and says nothing about
/// effort; an `assistant` event carries `message`, `parent_tool_use_id`,
/// `session_id`, `uuid`, `timestamp` and `request_id`, and no effort either —
/// with `--effort xhigh` passed explicitly, so this is not the field being
/// omitted at its default. The *session file* records it: a top-level `effort`
/// on every `assistant` record, `"xhigh"` in that probe and `"high"` in the same
/// probe run without the flag. So the only way to put it on the wall is to read
/// it, exactly as `read_ai_title` reads the generated name.
///
/// Read from the end in a doubling window rather than streamed whole, per
/// `relay::tail_of_transcript` — this runs at every settling turn, where
/// `ai_title_of`'s whole-file read runs on files that are mostly small and is
/// already the more expensive of the two.
///
/// Off the main thread, via `crate::off_main`: it is a file read, and the rule
/// on blocking commands does not care that it is usually a fast one.
#[tauri::command]
pub async fn read_session_effort(app: AppHandle, id: String) -> Result<Option<String>, String> {
    crate::off_main(move || effort_of(&app, id)).await?
}

/// The read itself, apart from the command that carries it.
fn effort_of(app: &AppHandle, id: String) -> Result<Option<String>, String> {
    let Some(path) = card_transcript(app, &id)? else {
        return Ok(None);
    };
    Ok(last_effort(&path))
}

/// The effort on the last record that states one, or `None`.
///
/// `None` is the ordinary answer for a card that has not spoken yet, and for a
/// transcript written by a build of Claude Code that did not record the field.
/// Neither is an error, and neither should put anything in the footer.
fn last_effort(path: &std::path::Path) -> Option<String> {
    let size = std::fs::metadata(path).ok()?.len();
    let mut window = EFFORT_TAIL_FROM;
    loop {
        let from = size.saturating_sub(window);
        if let Some(e) = effort_from(path, from) {
            return Some(e);
        }
        if from == 0 || window >= EFFORT_TAIL_MAX {
            return None;
        }
        window *= 2;
    }
}

/// The last effort stated in `[from, EOF)`.
///
/// A read that does not start at byte 0 drops its first line, per
/// `sessions::feed_range` and `relay::speeches_from`: half a record can still
/// carry `"effort"` and parse into nothing, and the cheap `contains` test below
/// would have let it through.
fn effort_from(path: &std::path::Path, from: u64) -> Option<String> {
    let mut file = File::open(path).ok()?;
    if from > 0 {
        file.seek(SeekFrom::Start(from)).ok()?;
    }
    let mut found = None;
    let mut first = true;
    for line in BufReader::new(file).lines() {
        let Ok(line) = line else { continue };
        let partial = first && from > 0;
        first = false;
        /* A cheap reject before parsing. Most of a transcript is tool results,
           and `serde_json` on every line of it is the whole cost of this. */
        if partial || !line.contains("\"effort\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        /* Top-level only. `effort` also appears inside the CLI's own listing of
           its slash commands, and a nested match would read that as a level. */
        if let Some(e) = v.get("effort").and_then(|e| e.as_str()) {
            if !e.trim().is_empty() {
                found = Some(e.to_string());
            }
        }
    }
    found
}

/// End a card's process and everything under it.
///
/// `async`, through `off_main`, and of the four commands here it is the one
/// that most needed it: `wait()` parks until the process is actually gone, and
/// a `claude` in the middle of a tool call does not go instantly. On the main
/// thread that was the whole wall unpainted for as long as one child took to
/// die — and worse than the usual case, because the mutex guard on the map is
/// a temporary that lives to the end of the `if let`, so **the supervisor lock
/// was held across the kill and the wait**. Every other card's `send_prompt`
/// queued behind it, on the one thread that could have drawn any of them.
/// See `crate::off_main`.
///
/// The map entry is taken and the lock let go before any of the blocking work,
/// which is worth keeping whatever thread this runs on.
#[tauri::command]
pub async fn close_conversation(app: AppHandle, id: String) -> Result<(), String> {
    crate::off_main(move || {
        let taken = app.state::<Supervisor>().0.lock().unwrap().remove(&id);
        if let Some(mut conv) = taken {
            /* The job first, so the whole tree goes at once rather than the agent
               dying and its servers and shells being orphaned in the gap. The kill
               below is then a no-op on Windows and the whole of it where no job
               could be made at all; the `wait` reaps the handle either way. */
            drop(conv.job.take());
            let _ = conv.child.kill();
            let _ = conv.child.wait();
        }
    })
    .await
}

/// Should the wall skip rousing its restored cards on load?
///
/// Set `SKEIN_NO_WAKE=1` and every card is painted and read for exactly as
/// before, and none of them is given a process until you speak to it — the
/// behaviour the wall had before rousing existed. Two reasons it has to be
/// reachable:
///
/// - a second Skein against the same store would otherwise resume every session
///   in the workspace a second time, appending to transcripts the first instance
///   is also holding. `SKEIN_NO_SERVERS` already exists for that pairing and
///   this is the same argument one layer up.
/// - a card that was interrupted is *sent a prompt*, which spends money and
///   starts an agent editing a repo. There has to be a way to open the wall and
///   look at it without that happening.
///
/// Advisory in exactly the way `servers_quiet` is: the flag means "don't do this
/// for me on load", not "these may not run", so every card still wakes the
/// moment it is spoken to.
#[tauri::command]
pub fn wake_quiet() -> bool {
    crate::servers::quiet(std::env::var("SKEIN_NO_WAKE").ok().as_deref())
}

/// What a card is holding beyond the fleet it booted with.
///
/// `None` where there is no reading — no process, no job, or no turn finished
/// yet. See `Supervisor::leftovers`; the badge draws nothing rather than a zero
/// it cannot stand behind.
#[derive(Serialize)]
pub struct Holding {
    pub excess: usize,
    pub fleet: usize,
}

/// Asked at a turn boundary rather than on a clock.
///
/// This is deliberately **not** a fourth poller, and the argument is the one
/// CLAUDE.md makes for folding an event that already exists: a card's tree only
/// grows because the agent did something, and "the agent did something" is
/// precisely what a `result` event announces. So the front end asks here when a
/// turn ends — an event it is already routing — and the reading is correct by
/// construction at the only moment it can have changed.
///
/// The residue is bounded the same way the update check is: nothing asks while
/// a card is idle, because nothing can have happened. A background process that
/// exits *between* turns leaves the count briefly high, which is the safe
/// direction — the next turn corrects it, and over-reporting a leak is a cheaper
/// mistake than hiding one.
///
/// `async` because it takes the supervisor's mutex, which `sample_performance`
/// holds across an enumeration — see the rule in CLAUDE.md about what waiting
/// for a lock on the main thread does to every card at once. The work itself is
/// one kernel call.
#[tauri::command]
pub async fn conversation_holding(
    app: AppHandle,
    id: String,
) -> Result<Option<Holding>, String> {
    crate::off_main(move || {
        Ok(app
            .state::<Supervisor>()
            .leftovers(&id)
            .map(|(excess, fleet)| Holding { excess, fleet }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Record the fleet at the end of a card's first turn.
///
/// Separate from `conversation_holding` so the front end can settle the
/// baseline and read the count in one turn-end fold without the two racing:
/// settling first means the very first reading is `0`, which is the truth — a
/// card that has just booted its servers is holding nothing extra.
#[tauri::command]
pub async fn settle_conversation_fleet(app: AppHandle, id: String) -> Result<(), String> {
    crate::off_main(move || {
        app.state::<Supervisor>().settle_fleet(&id);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::{fold_dir_name, plain};

    /// Every backticked `mcp__skein__…` in the appended prompt, in order.
    /// The two browsers are named, and named *correctly*.
    ///
    /// `named_tools` cannot hold this end down: it is scoped to `MCP_PREFIX` by
    /// construction, so a backticked `mcp__browser__*` is invisible to every
    /// assertion built on it. These servers come from the user's own MCP
    /// configuration rather than from anything this app writes, which means the
    /// prompt makes a claim the code cannot verify — the precise shape of the
    /// bug that guard exists for, one server across.
    ///
    /// So this is deliberately literal. It will not notice the user renaming a
    /// server, and nothing here can; what it *will* notice is somebody editing
    /// this paragraph and dropping a name, or the prohibition, or the sentence
    /// that routes an unsigned-in app to the person. Those are the edits that
    /// have actually happened to this prompt before.
    #[test]
    fn the_prompt_tells_a_card_which_browser_is_shared() {
        for me in fullest_and_none() {
            let p = append_prompt(false, me.as_ref());
            assert!(
                p.contains("mcp__browser__"),
                "the shared browser was not named: {p}"
            );
            assert!(
                p.contains("mcp__playwright__"),
                "the card's own browser was not named: {p}"
            );
            /* The prohibition has to survive an edit that shortens the
               paragraph, because it is the half that protects the other cards
               rather than this one — and it is therefore the half whose loss
               this card would never notice. */
            assert!(
                p.contains("clear its cookies"),
                "the paragraph no longer says not to clear the shared cookies: {p}"
            );
            /* And the correction that produced this sentence: the browsers are
               USUALLY signed in, and an agent told they always are improvises
               when it meets a login page. */
            assert!(
                !p.contains("already signed into"),
                "the paragraph promises a sign-in it cannot guarantee: {p}"
            );
            assert!(
                p.contains(&format!("{MCP_PREFIX}ask_user")),
                "an unsigned-in app is not routed to the user: {p}"
            );
        }

        /* A chat card has neither browser — `--tools WebSearch,WebFetch` and no
           MCP server but this one — so telling it about them would be an
           instruction to try what it will be refused. Same gate the roster and
           the git paragraphs sit behind. */
        let chat = append_prompt(true, None);
        assert!(
            !chat.contains("mcp__browser__") && !chat.contains("mcp__playwright__"),
            "a chat card was told about browsers it cannot reach: {chat}"
        );
    }

    /// `fullest()` and `None`, which is the pair every prompt assertion wants:
    /// the clauses a named card adds, and the prompt a card gets before it has
    /// been named at all.
    fn fullest_and_none() -> Vec<Option<Selfhood>> {
        vec![None, Some(fullest())]
    }

    fn named_tools(prompt: &str) -> Vec<String> {
        prompt
            .split('`')
            .skip(1)
            .step_by(2)
            .filter_map(|t| t.strip_prefix(MCP_PREFIX))
            .map(str::to_string)
            .collect()
    }

    /// What a card can actually call, asked of the server rather than listed
    /// here — so renaming a tool breaks this test instead of quietly stranding a
    /// sentence in the one paragraph every agent reads.
    fn advertised() -> Vec<String> {
        let r = crate::ask::dispatch(&serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "tools/list"
        }));
        let crate::ask::Dispatch::Reply(v) = r else { panic!("expected a reply") };
        v["result"]["tools"]
            .as_array()
            .expect("a list of tools")
            .iter()
            .map(|t| t["name"].as_str().expect("a name").to_string())
            .collect()
    }

    /// The four selfhoods a prompt can be composed against, so every assertion
    /// about tool names covers the clauses `Selfhood` adds rather than only the
    /// unconditional ones.
    ///
    /// `None` first, and it is not a hypothetical: it is what `system_prompt`
    /// gets from any future caller that has no card to speak of, and the arm
    /// that must still produce a usable prompt.
    fn selves() -> Vec<Option<Selfhood>> {
        let parent = |project: Option<&str>, elsewhere: bool| crate::store::Provenance {
            parent: "092198b5".into(),
            project: project.map(str::to_string),
            elsewhere,
        };
        vec![
            None,
            Some(Selfhood { handle: "4bd5340b".into(), spawned_by: None }),
            Some(fullest()),
            Some(Selfhood {
                handle: "f618d9b7".into(),
                spawned_by: Some(parent(Some("skein"), false)),
            }),
            /* A parent that has since been closed, which is the arm that names
               no project and must not send the card off to `send` to somebody
               who is not there. */
            Some(Selfhood {
                handle: "f618d9b7".into(),
                spawned_by: Some(parent(None, true)),
            }),
        ]
    }

    /// The selfhood that produces the most prose, for the tests that want one
    /// arm rather than all of them: a spawned card whose parent stands in
    /// another territory, which names every tool the clauses can name.
    ///
    /// It is the measured case in sink `0cf05791` — parent `092198b5` in `rise`,
    /// child in `workbench`, and therefore not in the rows a project-scoped
    /// `list` can see.
    fn fullest() -> Selfhood {
        Selfhood {
            handle: "f618d9b7".into(),
            spawned_by: Some(crate::store::Provenance {
                parent: "092198b5".into(),
                project: Some("rise".into()),
                elsewhere: true,
            }),
        }
    }

    /// The bug this guards is silent from both ends: the tools are there and
    /// described, and the prompt points the card at names for them that do not
    /// exist. Nothing errors — the agent simply never calls them, which is
    /// indistinguishable from it choosing not to.
    #[test]
    fn the_prompt_names_only_tools_the_server_advertises() {
        let known = advertised();
        for chat in [false, true] {
            for me in selves() {
                for tool in named_tools(&append_prompt(chat, me.as_ref())) {
                    assert!(
                        known.contains(&tool),
                        "the prompt names `{MCP_PREFIX}{tool}`, which tools/list does not \
                         advertise (chat={chat}); it advertises {known:?}"
                    );
                }
            }
        }
    }

    /// The bug this whole seam exists for: `--append-system-prompt` is
    /// last-one-wins, this function used to be two of them, and the person's
    /// own standing instructions were the one that lost — on every card that
    /// had an ask server, which is every card (sink a88048d9).
    ///
    /// Asserted as *containment of both*, not as a literal string, for the
    /// reason `the_roster_tools_are_advertised_beside_the_question` derives its
    /// expectation: a restated copy of the composed prompt would be a second
    /// source of truth that no compiler keeps honest.
    #[test]
    fn everything_appended_to_the_prompt_survives_being_composed() {
        let standing = "# Standing instructions\n\nMy name is Lyss.";
        for chat in [false, true] {
            let out = system_prompt(chat, true, Some(standing.to_string()), None)
                .expect("something to say");
            assert!(
                out.contains(standing),
                "the standing instructions were dropped (chat={chat}): {out}"
            );
            assert!(
                out.contains(&format!("{MCP_PREFIX}ask_user")),
                "the roster paragraph was dropped (chat={chat}): {out}"
            );
            /* Their words last — see the doc comment. A footnote to a paragraph
               about tool names is not where a person's own instructions go. */
            assert!(
                out.find(standing) > out.find(&format!("{MCP_PREFIX}ask_user")),
                "the standing instructions must come after the tooling: {out}"
            );
        }
    }

    /// Each half stands alone, because each is genuinely absent sometimes: a
    /// wall with no guidance set, and a spawn where the ask server did not come
    /// up. Neither may take the other down with it.
    #[test]
    fn either_half_of_the_prompt_can_be_missing() {
        let standing = "do the thing".to_string();

        let no_guidance = system_prompt(false, true, None, None).expect("the roster alone");
        assert!(no_guidance.contains(&format!("{MCP_PREFIX}board")));

        /* No ask server: naming tools that are not there is the failure
           `the_prompt_names_only_tools_the_server_advertises` guards from the
           other side, so the roster goes and the instructions still land. */
        let no_ask =
            system_prompt(false, false, Some(standing.clone()), None).expect("the guidance alone");
        assert_eq!(no_ask, standing);
        assert!(!no_ask.contains(MCP_PREFIX));

        /* Nothing to say is `None` rather than an empty argument. A bare
           `--append-system-prompt ""` is a flag the CLI still reads. */
        assert!(system_prompt(false, false, None, None).is_none());
        assert!(system_prompt(false, false, Some("   ".to_string()), None).is_none());
    }

    /// Advertised is not enough, and `append_prompt`'s own doc comment leans on
    /// the difference: it is short *because* every tool it names arrives with its
    /// description attached. That holds only while those tools are in the loaded
    /// tier. Defer one and nothing goes red — it is still in `tools/list`, the
    /// test above still passes, and the card is left with a bare name and one
    /// sentence of ours standing in for a schema it never sees.
    #[test]
    fn the_prompt_names_only_tools_whose_schemas_are_loaded() {
        let loaded: Vec<String> = crate::ask::roster()
            .iter()
            .filter(|t| t["_meta"]["anthropic/alwaysLoad"] == serde_json::json!(true))
            .map(|t| t["name"].as_str().expect("a name").to_string())
            .collect();
        for chat in [false, true] {
            /* Composed against the fullest selfhood there is, so the clauses
               a spawned card gets are inside every loop below rather than
               only the unconditional paragraphs. */
            let me = Some(fullest());
            let named = named_tools(&append_prompt(chat, me.as_ref()));
            /* Both this and the two tests around it are `for` loops over what
               the prompt names, so all three pass on a prompt that names
               nothing — and "names nothing" is what a bad edit to the format
               string, or to `named_tools`' backtick-pairing, would produce. A
               guard that goes green when its subject disappears is the shape
               sink 0b97adde is about, one turn of the screw further in. */
            assert!(
                !named.is_empty(),
                "the prompt names no tools at all (chat={chat}) — every assertion \
                 here is a loop over that list, so this is all three of them \
                 passing vacuously"
            );
            for tool in named {
                assert!(
                    loaded.contains(&tool),
                    "the prompt names `{MCP_PREFIX}{tool}`, which is deferred rather \
                     than loaded (chat={chat}); the loaded tier is {loaded:?}"
                );
            }
        }
    }

    /// The other direction, and the actual regression: a bare `board` or
    /// `ask_user` in backticks is the name this prompt carried for most of its
    /// life and the one thing no card can call.
    #[test]
    fn no_tool_is_named_without_its_server_prefix() {
        let known = advertised();
        for chat in [false, true] {
            let me = Some(fullest());
            let prompt = append_prompt(chat, me.as_ref());
            for tick in prompt.split('`').skip(1).step_by(2) {
                assert!(
                    !known.iter().any(|k| k == tick),
                    "`{tick}` is a tool name without `{MCP_PREFIX}` in front of it \
                     (chat={chat}), so nothing can call it"
                );
            }
        }
    }

    /// A chat card is refused the roster and the board by `relay.rs` and
    /// `board.rs`, so naming them would be an instruction to try what it will be
    /// told it may not do. `ask_user` is the one tool it does keep.
    #[test]
    fn a_chat_card_is_told_only_about_the_question() {
        let chat = append_prompt(true, Some(&fullest()));
        assert_eq!(named_tools(&chat), vec!["ask_user"]);
        let project = append_prompt(false, Some(&fullest()));
        for tool in ["ask_user", "board", "post", "unpost", "list", "send"] {
            assert!(
                named_tools(&project).iter().any(|t| t == tool),
                "a project card is not told about `{MCP_PREFIX}{tool}`"
            );
        }
    }

    /// A chat card is told none of this, and the reason is the same one that
    /// keeps the board and the roster off it: it cannot write a file, so there
    /// is no scratch directory for a handle to name, and `relay::do_list`
    /// refuses it the roster outright — so telling it which row is its own would
    /// name a thing it will be told it may not look at.
    #[test]
    fn a_chat_card_is_not_told_who_it_is() {
        let chat = append_prompt(true, Some(&fullest()));
        assert!(!chat.contains("f618d9b7"), "a chat card was told its own handle: {chat}");
        assert!(!chat.contains("SKEIN_CARD"), "a chat card was told about the variable");
        assert!(!chat.contains("092198b5"), "a chat card was told its parentage");
    }

    /// Sink `be79bb41`: the handle was always *gettable* and that was the
    /// complaint. A convention you must make a round trip to obey gets skipped
    /// under load, so the prompt states it and the environment carries it.
    ///
    /// Both spellings are asserted because they reach different consumers: the
    /// handle itself is what the model repeats in prose, and `$SKEIN_CARD` is
    /// what a shell command expands — a prompt naming one and not the other
    /// leaves half the point unmade.
    #[test]
    fn a_card_is_told_its_own_handle() {
        for me in selves().into_iter().flatten() {
            let p = append_prompt(false, Some(&me));
            assert!(p.contains(&me.handle), "the card was not told it is {}: {p}", me.handle);
            assert!(p.contains("$SKEIN_CARD"), "the variable was not named: {p}");
        }
        /* And nothing is claimed where nothing is known. A caller with no card
           gets a prompt with no sentence about one, rather than a sentence with
           a hole in it. */
        let anon = append_prompt(false, None);
        assert!(!anon.contains("SKEIN_CARD"), "a nameless card was told about the variable");
    }

    /// Sink `0cf05791`, and the three things the incident actually needed:
    /// *that* it was spawned, *who* by, and *where they are* — the last being
    /// the one that was missing, since `list` defaults to project scope and the
    /// parent stood in another territory.
    #[test]
    fn a_spawned_card_is_told_who_opened_it() {
        let p = append_prompt(false, Some(&fullest()));
        assert!(p.contains("092198b5"), "the parent was not named: {p}");
        assert!(p.contains("spawned card"), "the card was not told it was spawned: {p}");
        assert!(p.contains("rise"), "the parent's territory was not named: {p}");
        assert!(
            p.contains("scope: \"skein\""),
            "a parent in another territory is not in the default `list` scope, and the \
             card was not told to widen it: {p}"
        );

        /* A parent standing here needs no widening, and saying so anyway would
           teach every card to reach for the wider scope by reflex. */
        let beside = Selfhood {
            handle: "f618d9b7".into(),
            spawned_by: Some(crate::store::Provenance {
                parent: "092198b5".into(),
                project: Some("skein".into()),
                elsewhere: false,
            }),
        };
        let p = append_prompt(false, Some(&beside));
        assert!(p.contains("092198b5"));
        assert!(!p.contains("scope: \"skein\""), "told to widen a scope it does not need: {p}");

        /* A closed parent is still the card that wrote the brief and is still
           worth naming — but it cannot be sent to, and a card dispatched to a
           handle that answers nothing has been given an errand instead of the
           truth. */
        let orphan = Selfhood {
            handle: "f618d9b7".into(),
            spawned_by: Some(crate::store::Provenance {
                parent: "092198b5".into(),
                project: None,
                elsewhere: true,
            }),
        };
        let p = append_prompt(false, Some(&orphan));
        assert!(p.contains("since been closed"), "a closed parent was not said to be: {p}");
    }

    /// A card the *user* opened must not be told it was spawned, which is the
    /// same claim in the other direction and the one that would be quietly
    /// wrong: a card that believes it has an orchestrator goes looking for one.
    #[test]
    fn a_card_the_user_opened_is_told_no_such_thing() {
        let me = Selfhood { handle: "4bd5340b".into(), spawned_by: None };
        let p = append_prompt(false, Some(&me));
        assert!(!p.contains("spawned card"), "an ordinary card was told it was spawned: {p}");
        assert!(p.contains("4bd5340b"), "it should still know its own handle: {p}");
    }

    /// A child that exits with a known code, so reaping can be tested without a
    /// `claude` on the machine.
    #[cfg(windows)]
    fn dying_child(code: i32) -> Conv {
        dying_child_at(code, 0)
    }

    /// The same, stamped with a chosen generation, so a reap can be aimed at
    /// the wrong one on purpose.
    #[cfg(windows)]
    fn dying_child_at(code: i32, generation: u64) -> Conv {
        let mut child = Command::new("cmd")
            .args(["/C", &format!("exit {code}")])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("spawn cmd");
        let stdin = child.stdin.take().expect("piped stdin");
        Conv { child, stdin, turn: Arc::new(AtomicBool::new(false)), job: None, fleet: None, generation }
    }

    /// A child that will sit there until it is killed, so shutdown has something
    /// to drain that has not already gone away on its own.
    #[cfg(windows)]
    fn waiting_child(mid_turn: bool) -> Conv {
        let mut child = Command::new("cmd")
            // `more` reads stdin to EOF, and we are holding the write end.
            .args(["/C", "more"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("spawn cmd");
        let stdin = child.stdin.take().expect("piped stdin");
        Conv { child, stdin, turn: Arc::new(AtomicBool::new(mid_turn)), job: None, fleet: None, generation: 0 }
    }

    /// The bug this covers: shutdown returned every live child, and rousing
    /// gives every card on the wall one. So a clean quit flagged the whole wall
    /// interrupted and the next launch sent every card a resume prompt — cards
    /// at rest included.
    #[cfg(windows)]
    #[test]
    fn shutdown_reports_only_the_cards_that_were_mid_turn() {
        let sup = Supervisor::default();
        sup.0.lock().unwrap().insert("resting".into(), waiting_child(false));
        sup.0.lock().unwrap().insert("working".into(), waiting_child(true));

        let lost = sup.shutdown();

        assert_eq!(lost, vec!["working".to_string()]);
        assert!(
            sup.0.lock().unwrap().is_empty(),
            "shutdown has to drain the map whatever it reports"
        );
    }

    /// A card carrying something `child.kill()` cannot reach. `cmd /C ping`
    /// runs the ping as a process of its own, so it is a *grandchild* of the
    /// test and killing the `cmd` leaves it up — which is the shape a real card
    /// has: an MCP server's `cmd → node`, a `bash.exe` per Bash tool call, a
    /// backgrounded test run.
    ///
    /// The grandchild's pid is asked of the **job** rather than printed by the
    /// parent. It used to come out of a `powershell -Command "… Start-Process
    /// -PassThru; Write-Output $p.Id; [Console]::In.ReadToEnd()"`, which on this
    /// machine prints a pid and on the release runner handed back a closed pipe
    /// — so v0.4.0 failed at `parse::<u32>("")` inside the fixture, naming
    /// nothing about job objects and telling us nothing about the bug the test
    /// exists for. **A fixture that can fail for reasons of its own reports
    /// somebody else's weather.** `Job::pids` needs no cooperation from the
    /// child at all, since the kernel already knows what is in the job — and the
    /// ping is picked out of that list by its **image**, since the job holds the
    /// `cmd` we spawned and the `conhost.exe` the console dragged in with it as
    /// well.
    #[cfg(windows)]
    fn child_with_a_grandchild() -> (Conv, u32) {
        let mut child = Command::new("cmd")
            .args(["/C", "ping", "-n", "300", "127.0.0.1"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .expect("spawn cmd");

        let job = crate::servers::jobs::Job::new().expect("a job object");
        assert!(
            job.assign(child.id()),
            "the card's own process never joined the job, so there is nothing to test"
        );

        let parent = child.id();
        /* Polled for by *image*, not as "the pid that is not the parent". A
           console process drags a `conhost.exe` along with it and conhost joins
           the job like anything else the parent starts, so the first stranger in
           the list is as likely to be that as the ping — which is what the
           re-cut of v0.4.0 caught, one round trip after the fixture stopped
           asking powershell. Five seconds is a runner having a bad morning;
           past that it is a hang, and saying so beats waiting. */
        let mut found = None;
        for _ in 0..100 {
            found = job
                .pids()
                .into_iter()
                .find(|p| *p != parent && row(*p).to_lowercase().contains("ping.exe"));
            if found.is_some() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        /* Name what the job actually held. The whole point of this fixture is
           that when it goes wrong it says something about job objects. */
        let grandchild = found.unwrap_or_else(|| {
            let held: Vec<String> = job.pids().iter().map(|p| row(*p).trim().to_string()).collect();
            panic!("no ping under the cmd — the job held {held:?}")
        });

        let stdin = child.stdin.take().expect("piped stdin");
        (
            Conv { child, stdin, turn: Arc::new(AtomicBool::new(false)), job: Some(job), fleet: None, generation: 0 },
            grandchild,
        )
    }

    /// What `tasklist` says about a pid: its row, or nothing if it is gone.
    /// Both questions the grandchild test asks come off this one shell-out —
    /// whether a process is alive, and which image it is running.
    #[cfg(windows)]
    fn row(pid: u32) -> String {
        let out = Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .expect("tasklist");
        let text = String::from_utf8_lossy(&out.stdout).to_string();
        /* A filter that matches nothing still prints a sentence — "INFO: No
           tasks are running which match the specified criteria." — so an
           answer counts as one only if the pid is in it. */
        if text.contains(&pid.to_string()) {
            text
        } else {
            String::new()
        }
    }

    #[cfg(windows)]
    fn alive(pid: u32) -> bool {
        !row(pid).is_empty()
    }

    /// The bug this covers: a card is never one process, and `child.kill()` is
    /// `TerminateProcess` — it reaches the `claude.exe` and nothing under it.
    /// So closing a card orphaned its MCP servers, its shells and whatever it
    /// had backgrounded, and quitting the app left the whole day's worth of
    /// them running with no window to see them from. Measured on 2026-08-19: 80
    /// descendants under one Skein for 6 cards, the oldest sixteen hours old.
    ///
    /// `shutdown` rather than `close_conversation` because it needs no
    /// `AppHandle`; both take the same path through the job.
    #[cfg(windows)]
    #[test]
    fn quitting_takes_a_card_s_grandchildren_with_it() {
        let sup = Supervisor::default();
        let (conv, grandchild) = child_with_a_grandchild();
        sup.0.lock().unwrap().insert("card".into(), conv);

        assert!(alive(grandchild), "the grandchild should have started");

        sup.shutdown();

        /* The kill is delivered by the kernel as the job's last handle closes,
           so it is prompt rather than instant. */
        let mut gone = false;
        for _ in 0..50 {
            if !alive(grandchild) {
                gone = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        assert!(
            gone,
            "pid {grandchild} outlived the card that started it — the job object is not holding the tree"
        );
    }

    /// The badge counts what a card picked up *after* it booted, not what it is
    /// made of.
    ///
    /// The fixture's card is already two processes before anything asks it
    /// anything — the `cmd` and the `conhost` the console dragged in — which is
    /// the whole reason the reading is relative. A raw count would read `2` on a
    /// card that has done nothing, and on the real wall it reads ~11.
    ///
    /// So: settle the fleet with the grandchild already running, and the excess
    /// is nothing. The grandchild is *in* the fleet, which is the point — it was
    /// there when the card came up.
    #[cfg(windows)]
    #[test]
    fn the_fleet_a_card_boots_with_is_not_counted_against_it() {
        let sup = Supervisor::default();
        let (conv, grandchild) = child_with_a_grandchild();
        sup.0.lock().unwrap().insert("card".into(), conv);

        assert_eq!(
            sup.leftovers("card"),
            None,
            "a card that has not finished a turn has no reading — and must not report a zero it cannot stand behind"
        );

        sup.settle_fleet("card");
        let (excess, fleet) = sup.leftovers("card").expect("a settled card reads");
        assert!(
            fleet >= 2,
            "the fixture's own tree should be in the fleet, got {fleet}"
        );
        assert_eq!(
            excess, 0,
            "everything running at settle time is the fleet, so nothing is excess yet"
        );

        /* Settling is once and for all: a second turn must not re-baseline, or
           the count could only ever be zero. */
        sup.settle_fleet("card");
        assert_eq!(
            sup.leftovers("card").map(|(e, _)| e),
            Some(0),
            "re-settling would rebase the baseline and make the badge useless"
        );

        assert!(alive(grandchild), "the fixture should still be running");
        sup.shutdown();
    }

    /// And something started later *is* counted.
    ///
    /// The half that proves the reading is a reading rather than a constant
    /// zero: a process that joins the job after the fleet settled is exactly the
    /// headed Chromium left rendering after its task was torn down, which is the
    /// incident this whole seam exists for.
    #[cfg(windows)]
    #[test]
    fn a_process_started_after_the_fleet_settled_is_excess() {
        let sup = Supervisor::default();
        let (conv, _grandchild) = child_with_a_grandchild();
        sup.0.lock().unwrap().insert("card".into(), conv);
        sup.settle_fleet("card");
        assert_eq!(sup.leftovers("card").map(|(e, _)| e), Some(0));

        /* Assigned to the same job by hand, which is what a descendant of the
           card would have been given automatically. */
        let mut extra = Command::new("cmd")
            .args(["/C", "ping", "-n", "300", "127.0.0.1"])
            .stdout(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .expect("spawn the latecomer");
        {
            let map = sup.0.lock().unwrap();
            let job = map["card"].job.as_ref().expect("the card has a job");
            assert!(job.assign(extra.id()), "the latecomer never joined the job");
        }

        let (excess, _) = sup.leftovers("card").expect("a settled card reads");
        assert!(
            excess >= 1,
            "a process that joined after the fleet settled must be counted, got {excess}"
        );

        let _ = extra.kill();
        sup.shutdown();
    }

    /// A reader thread clears the row's mid-turn mark when its stream ends — a
    /// child that died holding a turn is a card saying so on the wall, and
    /// resuming it tomorrow spends money on a failure already shown. Quitting
    /// ends every stream the same way, so without this the kill would race the
    /// cards the mark exists for and clear exactly the ones worth keeping.
    #[test]
    fn shutdown_says_so_before_it_kills_anything() {
        let sup = Supervisor::default();
        assert!(!sup.going_away(), "a running app is not going anywhere");

        sup.shutdown();

        assert!(sup.going_away());
    }

    /// A turn opens on speech and closes on the result, and a spawn is neither.
    #[test]
    fn a_turn_opens_on_speech_and_closes_on_the_result() {
        assert_eq!(turn_mark("assistant"), Some(true));
        assert_eq!(turn_mark("user"), Some(true));
        assert_eq!(turn_mark("stream_event"), Some(true));
        assert_eq!(turn_mark("result"), Some(false));
        /* `system/init` arrives on every spawn, rousing's included — a card
           given its process back has said nothing and lost nothing. */
        assert_eq!(turn_mark("system"), None);
        assert_eq!(turn_mark("control_response"), None);
    }

    /// The bug this covers: nothing used to remove a finished child, so the id
    /// stayed in the map and `spawn_conversation` answered "already open"
    /// forever. `wake` believed it, and the next prompt went into a dead pipe.
    #[cfg(windows)]
    #[test]
    fn reaping_frees_the_id_and_reports_how_the_child_died() {
        let sup = Supervisor::default();
        sup.0.lock().unwrap().insert("c1".into(), dying_child(3));

        assert_eq!(sup.reap("c1", 0), Some(3), "the exit code never reached the card");
        assert!(
            !sup.0.lock().unwrap().contains_key("c1"),
            "a dead child kept its id, so the card could never be woken again"
        );
    }

    /// The guard `spawn_now` always meant to have. It read `contains_key` at the
    /// first line and `insert` at the last, with a store read, a git worktree —
    /// network `fetch` included — and a `CreateProcess` in between, on the
    /// blocking pool where two callers really can be inside it at once. Both
    /// were told the card was free; the map then kept the second child and the
    /// first went on running with no handle left to reach it.
    #[test]
    fn an_id_being_spawned_is_taken_before_the_child_exists() {
        let sup = Supervisor::default();
        let first = sup.claim("c1").expect("nothing holds it yet");
        assert!(
            sup.claim("c1").is_none(),
            "the second spawn was told the card was free, and made a second child"
        );
        assert!(sup.claim("c2").is_some(), "and it is per card, not a lock on spawning");
        drop(first);
        assert!(
            sup.claim("c1").is_some(),
            "a claim that outlives its spawn is a card that can never be woken again"
        );
    }

    /// The half the map already answered, kept: an id with a live child is taken
    /// whether or not anybody is mid-spawn on it.
    #[cfg(windows)]
    #[test]
    fn an_id_with_a_live_child_is_taken_too() {
        let sup = Supervisor::default();
        sup.0.lock().unwrap().insert("c1".into(), waiting_child(false));
        assert!(sup.claim("c1").is_none());
    }

    /// A deliberate close already removed and waited for the child, so there is
    /// nothing left to report — and nothing to panic about either.
    #[test]
    fn reaping_something_already_closed_is_quiet() {
        let sup = Supervisor::default();
        assert_eq!(sup.reap("never-existed", 0), None);
    }

    /// The bug this covers: a card's id outlives its processes, so a reader
    /// thread on its way out could take its *successor* out of the map — the
    /// live child of a card that had just been given a new process — and then
    /// block on `wait()` until that one died too. What was left was a running
    /// `claude` the supervisor could not reach: `send_prompt` answered "no open
    /// conversation" and `close_conversation` could not kill it.
    ///
    /// The window is `close_conversation` (which removes and waits) returning
    /// while the old reader thread still has its `persist_turn` to write, and
    /// `#moveTo` in `skein.svelte.ts` closed and woke inside it.
    #[cfg(windows)]
    #[test]
    fn a_superseded_reader_thread_reaps_nothing() {
        let sup = Supervisor::default();
        /* Generation 1 is the card's current process; the thread arriving late
           belongs to generation 0, which a deliberate close already took. */
        sup.0.lock().unwrap().insert("c1".into(), dying_child_at(3, 1));

        assert_eq!(
            sup.reap("c1", 0),
            None,
            "an old reader thread reported the exit code of a process it does not own"
        );
        assert!(
            sup.0.lock().unwrap().contains_key("c1"),
            "a superseded reader thread took the card's live process out of the map"
        );

        // And the thread that does own it still reaps normally.
        assert_eq!(sup.reap("c1", 1), Some(3));
    }

    #[test]
    fn transcript_dir_matches_claude_codes_own_naming() {
        // Verified against the real directories on disk.
        assert_eq!(fold_dir_name("C:\\atelier"), "C--atelier");
        assert_eq!(fold_dir_name("C:\\atelier\\caravan"), "C--atelier-caravan");
        assert_eq!(
            fold_dir_name("C:\\Users\\flori\\codes\\rise"),
            "C--Users-flori-codes-rise"
        );
    }

    #[test]
    fn forward_slashes_encode_the_same_way() {
        assert_eq!(fold_dir_name("C:/atelier/skein"), "C--atelier-skein");
    }

    #[test]
    fn case_is_preserved() {
        // C--Users-... keeps its capital U on disk.
        assert_eq!(fold_dir_name("C:\\Users"), "C--Users");
    }

    /// The bug: only separators folded, so `.scratch` kept its dot, the path
    /// missed, and every card under it stayed untitled. All three expectations
    /// are directory names claude 2.1.228 actually created — see the doc comment
    /// on `transcript_dir_name` for the probe.
    #[test]
    fn every_non_alphanumeric_folds_to_a_dash() {
        assert_eq!(
            fold_dir_name("C:\\atelier\\skein\\.scratch\\wall"),
            "C--atelier-skein--scratch-wall"
        );
        assert_eq!(fold_dir_name("slug_probe a.b+c"), "slug-probe-a-b-c");
        assert_eq!(fold_dir_name("café_naïve-Ω9"), "caf--na-ve--9");
    }

    /// Replacement is per UTF-16 code unit, as in the JS that does it upstream,
    /// so a char outside the BMP is two dashes. `char`-wise mapping gives one.
    #[test]
    fn an_astral_char_folds_to_two_dashes() {
        assert_eq!(fold_dir_name("emoji\u{1F33F}probe"), "emoji--probe");
    }

    /// `\\?\C:\x` and `C:\x` are one directory and fold to two slugs, so the
    /// prefix `canonicalize` adds has to come back off — resolving the path and
    /// then filing it under the verbatim spelling would be the same bug wearing
    /// the other shoe. The UNC arm is why this is not a single `strip_prefix`.
    #[test]
    fn the_verbatim_prefix_comes_off() {
        assert_eq!(plain(r"\\?\C:\atelier\skein"), r"C:\atelier\skein");
        assert_eq!(plain(r"C:\atelier\skein"), r"C:\atelier\skein");
        assert_eq!(plain(r"\\?\UNC\build\share\rise"), r"\\build\share\rise");
    }

    /// The bug: two spellings of one directory, folding to two slugs, and only
    /// one of them the CLI's. `C:\Users\lyss` on this machine is a junction to
    /// `C:\Users\flori`, so a child spawned with the row's `cwd` filed its
    /// transcript under the target — while Skein asked whether one existed under
    /// the junction, where it never did, chose `--session-id`, and the CLI
    /// refused it with `Error: Session ID … is already in use.`
    ///
    /// It makes a real junction, because nothing else reproduces this: every
    /// string test in this module passed throughout, and 17 cards under two
    /// territories could not be woken.
    #[test]
    #[cfg(windows)]
    fn a_junction_folds_to_what_it_points_at() {
        use super::transcript_dir_name;

        let base = std::env::temp_dir().join(format!("skein-junction-{}", std::process::id()));
        let (real, link) = (base.join("real"), base.join("link"));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&real).unwrap();
        let made = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&link)
            .arg(&real)
            .output()
            .is_ok_and(|o| o.status.success());
        if !made {
            /* No junction to be had — nothing to assert about one. Skipped
               rather than failed: `mklink` is not this crate's to guarantee. */
            let _ = std::fs::remove_dir_all(&base);
            return;
        }

        /* Both shapes, and the second is the one that shipped: the junction on
           this machine is at `C:\Users\lyss`, three segments above the directory
           a card actually runs in, so a reparse point in the *middle* of the
           path is what has to resolve. */
        for (a, b) in [(link.clone(), real.clone()), (link.join("codes"), real.join("codes"))] {
            std::fs::create_dir_all(&b).unwrap();
            let (a, b) = (a.to_str().unwrap(), b.to_str().unwrap());
            assert_ne!(
                fold_dir_name(a),
                fold_dir_name(b),
                "the two spellings must differ, or this test proves nothing"
            );
            assert_eq!(
                transcript_dir_name(a),
                transcript_dir_name(b),
                "a junction and its target are one directory and file in one place"
            );
        }

        let _ = std::fs::remove_dir_all(&link);
        let _ = std::fs::remove_dir_all(&base);
    }

    /// A directory that is not there resolves to nothing, and the answer is the
    /// string it was given — which is what every caller already handles, since
    /// "no transcript" is the reading it produces.
    #[test]
    fn an_unresolvable_path_folds_as_written() {
        assert_eq!(
            super::transcript_dir_name("C:\\nowhere\\at\\all\\really"),
            "C--nowhere-at-all-really"
        );
    }

    /// One transcript's worth of records, in the shape claude 2.1.233 writes
    /// them: `effort` is a top-level field on the assistant record, beside
    /// `message` rather than inside it.
    fn spoke(effort: &str, filler: usize) -> String {
        format!(
            "{{\"type\":\"assistant\",\"effort\":\"{effort}\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"{}\"}}]}}}}\n",
            "x".repeat(filler)
        )
    }

    fn temp_transcript(body: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "skein-effort-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session.jsonl");
        std::fs::write(&path, body).unwrap();
        path
    }

    /// The last one wins: `/effort` mid-session changes what later turns run at,
    /// and the footer is about the card as it stands.
    #[test]
    fn the_last_effort_stated_is_the_answer() {
        let path = temp_transcript(&format!("{}{}", spoke("high", 4), spoke("xhigh", 4)));
        assert_eq!(last_effort(&path).as_deref(), Some("xhigh"));
        std::fs::remove_file(&path).ok();
    }

    /// A card that has been opened and never spoken to has no file at all, and a
    /// transcript from a build that did not record the field has no effort in
    /// it. Neither is an error and neither draws anything.
    #[test]
    fn no_transcript_and_no_field_both_answer_none() {
        let missing = std::env::temp_dir().join("skein-no-such-effort.jsonl");
        assert_eq!(last_effort(&missing), None);

        let path = temp_transcript(
            "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[]}}\n",
        );
        assert_eq!(last_effort(&path), None);
        std::fs::remove_file(&path).ok();
    }

    /// The window doubles until it finds one. A megabyte of tool result between
    /// the last speech and EOF is ordinary — one `Read` of a large file does it
    /// — and the first 256 KB pass then lands entirely inside records that state
    /// no effort.
    #[test]
    fn the_window_grows_past_a_wall_of_tool_output() {
        let mut body = spoke("max", 8);
        for _ in 0..6 {
            body.push_str(&format!(
                "{{\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":\"{}\"}}}}\n",
                "y".repeat(200 * 1024)
            ));
        }
        let path = temp_transcript(&body);
        assert_eq!(last_effort(&path).as_deref(), Some("max"));
        std::fs::remove_file(&path).ok();
    }

    /// The half-record at the window's edge is dropped rather than parsed. It
    /// still contains `"effort"`, so the cheap `contains` test alone would let
    /// it through to a parse that fails — and a *later* full record must not be
    /// lost to that.
    #[test]
    fn a_line_cut_in_half_costs_nothing() {
        let body = spoke("low", 64);
        let path = temp_transcript(&body);
        /* Start inside the first record: what is left of it carries the field
           and cannot be parsed, and there is nothing else in the file. */
        assert_eq!(effort_from(&path, 20), None);
        assert_eq!(effort_from(&path, 0).as_deref(), Some("low"));
        std::fs::remove_file(&path).ok();
    }
}

impl Supervisor {
    /// Reserve an id for a spawn about to start, or refuse it because one
    /// already has it.
    ///
    /// The whole of the guard `spawn_now` used to spell as a `contains_key` at
    /// its first line — with the difference that this is *held* across the work
    /// rather than consulted before it. Both questions are asked under one lock
    /// so the answer cannot change between them: an id is taken if a child is
    /// live under it, and taken if somebody is on their way to making one.
    ///
    /// Lock order is `.2` then `.0`, and it is the only place in this module
    /// that holds two at once — every other path takes `.0` alone, so there is
    /// no second order for this one to deadlock against. Keep it that way.
    fn claim(&self, id: &str) -> Option<Claim<'_>> {
        let mut starting = self.2.lock().ok()?;
        if starting.contains(id) {
            return None;
        }
        if self.0.lock().ok()?.contains_key(id) {
            return None;
        }
        starting.insert(id.to_string());
        Some(Claim { sup: self, id: id.to_string() })
    }

    /// Take a finished conversation out of the map and collect its exit code.
    ///
    /// Called from the stdout reader once the stream ends. Returning `None` when
    /// the id is absent is the normal case for a deliberate close: the command
    /// already removed and waited for the child, so there is nothing to report
    /// and the card is on its way off the wall anyway. A code therefore only
    /// ever appears when the child went away on its own — which is exactly when
    /// the card needs to say so.
    /* A child that went away on its own still leaves its tree behind, so the
       job is swept here too — by `conv` being dropped at the end of the
       function, once the code has been read off it. */
    /// Take a finished child out of the map and say how it died.
    ///
    /// `generation` is what makes this safe to call from a reader thread that
    /// may have been superseded — see `Conv::generation`. Removing by id alone
    /// meant an old thread could take the card's *current*, live process out of
    /// the map and then block on `wait()` until it died.
    fn reap(&self, id: &str, generation: u64) -> Option<i32> {
        let mut map = self.0.lock().unwrap();
        if map.get(id)?.generation != generation {
            return None;
        }
        let mut conv = map.remove(id)?;
        /* Outside the lock would be nicer, but this child is already dead —
           its stdout is what just closed — so the wait returns at once. */
        conv.child.wait().ok().and_then(|status| status.code())
    }

    /// Whether the app is shutting down, asked by the reader threads as their
    /// streams end. See the note on the field.
    fn going_away(&self) -> bool {
        self.1.load(Ordering::Relaxed)
    }

    /// Which live process belongs to which conversation.
    ///
    /// The performance widget's whole reason for being inside Skein: a machine
    /// running six cards has six `claude.exe` in Task Manager and no way to tell
    /// which is which. The mapping is only meaningful while the child is alive,
    /// so it is read fresh on every sample rather than kept anywhere.
    pub fn pids(&self) -> HashMap<u32, String> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .map(|(id, conv)| (conv.child.id(), id.clone()))
            .collect()
    }

    /// Whether this card has a process, and whether a turn is open on it.
    ///
    /// The two halves of what `relay.rs` calls a card's state, and the two the
    /// database cannot answer: a row says what a card *is*, and only the map
    /// says whether anything is running. Read together under one lock, because
    /// asked separately they can disagree — a card that exits between the two
    /// questions reads as dormant and mid-turn at once.
    pub fn liveness(&self, id: &str) -> (bool, bool) {
        match self.0.lock().unwrap().get(id) {
            Some(conv) => (true, conv.turn.load(Ordering::Relaxed)),
            None => (false, false),
        }
    }

    /// Every process each card owns, pid → conversation id.
    ///
    /// `pids` answers with the `claude` process alone, which is all the
    /// performance meter needs in order to *recognise* a card and hang the rest
    /// off it by ancestry. This answers with the whole tree, which is what
    /// listing and reaping need, and the difference is not convenience: see
    /// `jobs::Job::pids` for why the parent map goes blind on exactly the
    /// processes worth finding.
    ///
    /// Only conversations. Dev servers and project runs hold jobs of their own
    /// and already have a visible stop apiece; a card's tree was the one with
    /// no way in.
    pub fn owned_pids(&self) -> HashMap<u32, String> {
        let mut out = HashMap::new();
        for (id, conv) in self.0.lock().unwrap().iter() {
            if let Some(job) = &conv.job {
                for pid in job.pids() {
                    out.insert(pid, id.clone());
                }
            }
        }
        out
    }

    /// What this card owns beyond the fleet it booted with, and how big that
    /// fleet is.
    ///
    /// Returns `(excess, fleet_size)`, or `None` for a card that has no process
    /// or has not finished a turn yet — an unknown reading, which the badge
    /// draws as nothing rather than as zero. The difference matters: zero is a
    /// claim, and this is the one place that must not make one it cannot back.
    ///
    /// Membership comes from the job rather than from a parent walk, for the
    /// reason `jobs::Job::pids` gives at length: the processes worth finding are
    /// by definition the ones whose intermediate parent has exited, and that is
    /// exactly where ancestry goes blind. It is also the only *proof* of
    /// ownership available, which is what makes the badge safe to act on — the
    /// count is of processes this wall is entitled to end.
    ///
    /// Cheap on purpose. `QueryInformationJobObject` is one kernel call per card
    /// and touches no process table, so this is nothing like a performance
    /// sample and is affordable at every turn boundary.
    pub fn leftovers(&self, id: &str) -> Option<(usize, usize)> {
        let map = self.0.lock().unwrap();
        let conv = map.get(id)?;
        let job = conv.job.as_ref()?;
        let fleet = conv.fleet.as_ref()?;
        let now = job.pids();
        let excess = now.iter().filter(|p| !fleet.contains(p)).count();
        Some((excess, fleet.len()))
    }

    /// Record the fleet, if this card has not got one yet.
    ///
    /// Called at the end of a turn — see the field. Idempotent and silent on a
    /// card with no job, since a non-Windows build has none and the reading is
    /// simply unavailable there.
    pub fn settle_fleet(&self, id: &str) {
        let mut map = self.0.lock().unwrap();
        let Some(conv) = map.get_mut(id) else { return };
        if conv.fleet.is_some() {
            return;
        }
        if let Some(job) = &conv.job {
            conv.fleet = Some(job.pids().into_iter().collect());
        }
    }

    /// Children die with the app. Nothing is left editing a repo unwatched.
    ///
    /// Returns the ids that were **mid-turn**, because they are the only ones
    /// that lost anything — see `store::mark_interrupted`.
    ///
    /// It used to return every id in the map, on the reading that a live child
    /// is a card that was working. That was already loose and rousing made it
    /// false for the whole wall: every dormant card is given its process back at
    /// launch, so by the time you quit, *every* card has a child here, every one
    /// of them was flagged interrupted, and the next launch sent the whole wall
    /// a `resumePrompt` — money and an agent apiece for turns that had finished
    /// hours ago. A process is not a turn; `Conv::turn` is the turn.
    ///
    /// Read before the kill rather than after: killing closes stdout, and the
    /// reader thread clears the flag on its way out.
    ///
    /// Raising `going_away` before the first kill is the other half of that. A
    /// reader thread now clears the *row's* mark as well when its stream ends,
    /// and every stream here is about to end — without this, quitting mid-turn
    /// would race the very cards it is meant to flag.
    pub fn shutdown(&self) -> Vec<String> {
        self.1.store(true, Ordering::Relaxed);
        let mut map = self.0.lock().unwrap();
        let mut lost = Vec::new();
        for (id, mut conv) in map.drain() {
            if conv.turn.load(Ordering::Relaxed) {
                lost.push(id);
            }
            /* "Children die with the app" was only ever true of the `claude`
               process itself; everything it had started stayed up. */
            drop(conv.job.take());
            let _ = conv.child.kill();
            let _ = conv.child.wait();
        }
        lost
    }
}
