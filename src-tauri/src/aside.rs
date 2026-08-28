//! A quick question you can ask a card without interrupting what it is doing.
//!
//! `/btw` in the Claude Code TUI, asked for on this wall by the user (sink
//! bab5415f). The CLI's own one-line description of it is exact and is worth
//! keeping: *"Ask a quick side question without interrupting the main
//! conversation."*
//!
//! ## Why this had to be built rather than passed through
//!
//! Read out of the 2.1.241 binary on this machine, 2026-08-28. `/btw` is
//! implemented in the **Ink layer** — the string `"/btw"` appears inside a
//! `_d.jsxs(...)` call, beside `"Side questions aren't available when viewing a
//! session read-only"` and `"This remote connection doesn't support side
//! questions"`. Volery drives `claude --print`, which has no Ink and therefore
//! no `/btw`: handing the CLI the command as a prompt gets it treated as text.
//! So the mechanism is ours to assemble, and the parts are all published.
//!
//! ## What the CLI actually does, and what we copy
//!
//! - **It forks.** The session context spreads `btwHistory: e.kind === "fork" ?
//!   e.root.btwHistory : new q4s`, and the fallback-model schema describes
//!   `scope: "local"` as *"a subagent / side-question (/btw) / background fork
//!   fell back"*. So a side question is a fork of the conversation, not a turn
//!   in it. `--fork-session` is that flag on the `--print` path — "when
//!   resuming, create a new session ID" — and it is what keeps the card's own
//!   transcript untouched. **That is the whole feature**: the answer costs a
//!   request and changes nothing about the conversation it was asked beside.
//! - **It frames the question.** Verbatim from the binary:
//!   `<system-reminder>This is a side question from the user. You must answer
//!   this question directly in a single response.` Used as-is rather than
//!   reworded, because the second sentence is what stops the fork picking up
//!   tools and working — and a fork that started editing files would be the
//!   opposite of "without interrupting".
//! - **It keeps the pairs in memory and nowhere else.** `class q4s { exchanges
//!   = [] ... .slice(-20) }`, hung on the session context. Nothing is written to
//!   disk. So an aside on this wall is ephemeral too, and that is a *match*
//!   rather than a shortcut — it settles what would otherwise be a real question
//!   about persisting something the CLI's own session file will never contain.
//!   `.claude/rules/panel.md` says so where a reader will meet it.
//!
//! ## What it costs, and the two bounds
//!
//! A fork re-reads the conversation, so an aside on a large card is an uncached
//! read of the whole context. It is a real request against the card's own
//! account, which is why `ASIDE_CAP` bounds the answer and `ASIDE_TIMEOUT`
//! bounds the wait: a side question that sat there for five minutes would be
//! the interruption it exists to avoid, arriving late.
//!
//! One at a time per card. A second `/btw` while the first is out replaces it,
//! the way a second `!` does in `bang.rs` — two asides interleaving their
//! answers onto one card is not a reading anybody wants.

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};

use crate::servers::jobs;

/// The framing the CLI puts on a side question, verbatim.
///
/// **Not reworded.** The second sentence is load-bearing: it is what keeps the
/// fork from picking up tools and starting work, and a fork that began editing
/// files would be precisely the interruption `/btw` exists to avoid. Read out of
/// the 2.1.241 bundle.
pub(crate) const FRAME: &str = "<system-reminder>This is a side question from the user. \
     You must answer this question directly in a single response.";

/// The most of an answer this will carry back.
///
/// An aside is a line or two in a panel beside a conversation, not a document.
/// The frame above asks for a single response and the model obliges, so this is a
/// backstop rather than a routine cut — and it is *said* when it bites, because
/// a silently halved answer is worse than a short one.
const ASIDE_CAP: usize = 8_000;

/// How long to wait before giving up on one.
///
/// Ninety seconds. A side question that arrived five minutes later would be the
/// interruption it exists to avoid, and a fork of a large conversation is an
/// uncached read — so this is generous rather than tight, and finite rather than
/// absent.
const ASIDE_TIMEOUT_S: u64 = 90;

/// The asides in flight, one per card.
#[derive(Default)]
pub struct Asides {
    /// `conversation id -> generation`. A number rather than a handle: the child
    /// is owned by the thread that spawned it and the only thing another thread
    /// needs is to be able to say "you are no longer the current one", which is
    /// the same shape `servers::RunningGroup::polling` settled on.
    live: Mutex<std::collections::HashMap<String, u64>>,
    next: AtomicU64,
}

impl Asides {
    /// Claim the card for a new aside, returning this one's generation.
    fn claim(&self, id: &str) -> u64 {
        let gen = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        if let Ok(mut m) = self.live.lock() {
            m.insert(id.to_string(), gen);
        }
        gen
    }

    /// Is this generation still the card's current aside?
    fn current(&self, id: &str, gen: u64) -> bool {
        self.live.lock().map(|m| m.get(id) == Some(&gen)).unwrap_or(false)
    }

    fn release(&self, id: &str, gen: u64) {
        if let Ok(mut m) = self.live.lock() {
            if m.get(id) == Some(&gen) {
                m.remove(id);
            }
        }
    }
}

/// What the front end is told when an aside settles.
#[derive(Clone, serde::Serialize)]
pub struct Answered {
    pub id: String,
    pub question: String,
    /// The answer, or an empty string when `failed` says why instead.
    pub answer: String,
    /// What went wrong, if anything did. Said rather than swallowed: an aside
    /// that silently never arrives is indistinguishable from one still coming.
    pub failed: Option<String>,
    /// The answer was cut at `ASIDE_CAP`.
    pub clipped: bool,
}

/// Ask one, and emit `aside:answered` when it settles.
///
/// `off_main` because this spawns a process and waits on it — see the note in
/// `lib.rs`. The whole of the work happens on that thread, including the read, so
/// nothing here can park the one that paints the wall.
#[tauri::command]
pub async fn ask_aside(
    app: AppHandle,
    id: String,
    question: String,
) -> Result<(), String> {
    let asked = question.trim().to_string();
    if asked.is_empty() {
        return Err("a side question with no question in it".into());
    }
    crate::off_main(move || run(&app, &id, &asked)).await?
}

fn run(app: &AppHandle, id: &str, question: &str) -> Result<(), String> {
    let gen = app.state::<Asides>().claim(id);

    let out = match ask(app, id, question) {
        Ok((answer, clipped)) => Answered {
            id: id.to_string(),
            question: question.to_string(),
            answer,
            failed: None,
            clipped,
        },
        Err(why) => Answered {
            id: id.to_string(),
            question: question.to_string(),
            answer: String::new(),
            failed: Some(why),
            clipped: false,
        },
    };

    /* Superseded while it was out: a second `/btw` replaced this one, and
       delivering both would put two answers under one question. Dropped
       silently, which is what "replaced" means. */
    if !app.state::<Asides>().current(id, gen) {
        return Ok(());
    }
    app.state::<Asides>().release(id, gen);
    let _ = app.emit("aside:answered", out);
    Ok(())
}

/// The request itself: a forked, one-shot `claude --print`.
fn ask(app: &AppHandle, id: &str, question: &str) -> Result<(String, bool), String> {
    let store = app.state::<crate::store::Store>();
    /* `session_of` answers with the directory the card's *child* runs in and the
       session id, which is exactly the pair a fork needs — and for a worktree
       card those are not the row's `cwd`, since the CLI files a transcript under
       whichever directory it is running in. See the note there.

       No session id means a card that has never taken a turn, and there is
       nothing to fork: `--resume` on an id the CLI has never written would fail
       in the child with a message about a missing session, so it is refused here
       with one that says what to do. */
    let (cwd, session) = {
        let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
        let Some((dir, session)) = crate::store::session_of(&conn, id) else {
            return Err("that card is not on the wall".into());
        };
        let account = crate::store::account_of(&conn, id);
        let Some(session) = session.filter(|s| !s.trim().is_empty()) else {
            return Err(
                "this card has not taken a turn yet, so there is no conversation to ask \
                 beside — send it something first"
                    .into(),
            );
        };
        (dir, (session, account))
    };
    let (session, account) = session;

    let program = {
        let home = app.path().home_dir().map_err(|e| format!("no home dir: {e}"))?;
        crate::claude::program(&home)
    };

    let mut cmd = Command::new(&program);
    cmd.current_dir(&cwd);
    cmd.args([
        "--print",
        "--output-format",
        "text",
        "--resume",
        &session,
        /* The whole point. Without it the aside becomes a turn in the card's own
           session and the transcript grows a question the conversation never
           asked — which is the opposite of "without interrupting". */
        "--fork-session",
        /* No tools at all. The frame already tells the model to answer in one
           response; this is the half that means it cannot do otherwise. A fork
           that reached for Edit would be editing the card's repository from a
           question the card never saw. */
        "--tools",
        "",
        "--strict-mcp-config",
    ]);

    /* The card's own subscription, and the same hard failure `spawn_now` gives
       rather than a silent fall-through to whoever is signed in — an aside must
       not quietly spend the account being held in reserve. */
    if let Some(label) = account.filter(|s| !s.trim().is_empty()) {
        if !crate::accounts::signed_in(app, &label) {
            return Err(format!("'{label}' is not signed in"));
        }
        let dir = crate::accounts::store_dir(app, &label)?;
        cmd.env("CLAUDE_SECURESTORAGE_CONFIG_DIR", &dir);
        cmd.env_remove("CLAUDE_CODE_OAUTH_TOKEN");
    }

    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    let mut child = cmd.spawn().map_err(|e| format!("could not ask: {e}"))?;

    /* A job object, per the rule that has no exceptions: a `claude` child of our
       own carries a `conhost` and whatever else it starts, and `kill()` reaches
       exactly one process. Without this an aside that timed out would leave its
       tree running with nothing holding a handle on it. */
    let job = jobs::Job::new();
    if let Some(j) = &job {
        j.assign(child.id());
    }

    if let Some(mut w) = child.stdin.take() {
        let _ = w.write_all(FRAME.as_bytes());
        let _ = w.write_all(b"\n\n");
        let _ = w.write_all(question.as_bytes());
        let _ = w.write_all(b"\n");
        let _ = w.flush();
        /* And EOF, which is what makes `--print` answer and exit. */
    }

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    /* stderr on its own thread, or a child that fills that pipe blocks forever
       while we read the other one. Kept for the failure message rather than
       drawn: `claude`'s stderr is where a refusal explains itself. */
    let errs = std::thread::spawn(move || {
        let mut out = String::new();
        if let Some(r) = stderr {
            for line in BufReader::new(r).lines().map_while(Result::ok) {
                if out.len() < 2_000 {
                    out.push_str(&line);
                    out.push('\n');
                }
            }
        }
        out
    });

    let reader = std::thread::spawn(move || {
        let mut out = String::new();
        let mut clipped = false;
        if let Some(r) = stdout {
            for line in BufReader::new(r).lines().map_while(Result::ok) {
                if out.len() >= ASIDE_CAP {
                    clipped = true;
                    break;
                }
                out.push_str(&line);
                out.push('\n');
            }
        }
        (out, clipped)
    });

    /* A finite wait. `wait_timeout` is not in std, so this is the poll every
       other one-shot here uses: ask, sleep, ask again. The interval is coarse
       because the thing being waited on takes seconds at best. */
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(ASIDE_TIMEOUT_S);
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) => {}
            Err(e) => return Err(format!("could not ask: {e}")),
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    };

    let (answer, clipped) = reader.join().unwrap_or_else(|_| (String::new(), false));
    let said = errs.join().unwrap_or_default();

    let Some(status) = status else {
        return Err(format!("no answer in {ASIDE_TIMEOUT_S}s — the side question was dropped"));
    };
    let answer = answer.trim().to_string();
    if !status.success() && answer.is_empty() {
        let why = said.trim();
        return Err(if why.is_empty() {
            format!("the side question failed ({status})")
        } else {
            why.lines().last().unwrap_or(why).to_string()
        });
    }
    if answer.is_empty() {
        return Err("it answered with nothing".into());
    }
    Ok((answer, clipped))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The framing is quoted from the CLI, and the second sentence is why.
    ///
    /// Asserted rather than trusted to review, because the whole difference
    /// between an aside and a turn is that the fork answers instead of working —
    /// and this string plus `--tools ""` is the entirety of what enforces it.
    #[test]
    fn the_frame_asks_for_an_answer_rather_than_work() {
        assert!(FRAME.starts_with("<system-reminder>"), "{FRAME}");
        assert!(FRAME.contains("side question from the user"), "{FRAME}");
        /* The half that stops it working. */
        assert!(FRAME.contains("single response"), "{FRAME}");
        assert!(FRAME.contains("answer this question directly"), "{FRAME}");
    }

    /// One at a time per card, and a superseded one is dropped rather than
    /// delivered late under a question it does not answer.
    #[test]
    fn a_second_aside_supersedes_the_first() {
        let a = Asides::default();
        let first = a.claim("c1");
        assert!(a.current("c1", first));

        let second = a.claim("c1");
        assert!(a.current("c1", second));
        assert!(!a.current("c1", first), "the first is no longer the card's aside");

        /* And the loser releasing does not take the winner's claim with it —
           `release` is guarded on the generation for exactly this. */
        a.release("c1", first);
        assert!(a.current("c1", second));
        a.release("c1", second);
        assert!(!a.current("c1", second));
    }

    /// Cards do not share the claim. Obvious, and worth one line: the map is
    /// keyed by conversation and an aside on one card must not cancel another's.
    #[test]
    fn one_card_does_not_cancel_anothers() {
        let a = Asides::default();
        let one = a.claim("c1");
        let two = a.claim("c2");
        assert!(a.current("c1", one));
        assert!(a.current("c2", two));
    }

    /// A generation is never reused, so a claim released and re-taken cannot be
    /// mistaken for the earlier one by a thread that has been asleep.
    #[test]
    fn a_generation_is_never_handed_out_twice() {
        let a = Asides::default();
        let mut seen = std::collections::HashSet::new();
        for _ in 0..50 {
            assert!(seen.insert(a.claim("c1")), "a generation came back twice");
        }
    }
}
