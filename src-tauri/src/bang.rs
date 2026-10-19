//! `!` in the dock: running one line, and completing one line.
//!
//! Two unrelated jobs that share a shell dialect, which is why they are one
//! file — the same argument `shell.rs` makes for keeping its marker next to its
//! argv. Neither of them is the floating shell, and the difference is worth
//! being clear about before reading either.
//!
//! **A run is a process per command.** The floating shell is one long-lived
//! `pwsh` you keep talking to; a `!` line is not. It is spawned, told one thing,
//! and its stdin is closed — which is what `-Command -` reads as "that is
//! everything", so the shell runs it and exits. No marker is needed anywhere
//! here: the process ending *is* the end of the command, and its exit status is
//! the status. That is the whole reason this is not a second client of
//! `shell.rs` — the marker exists because a shell that outlives its commands
//! cannot otherwise say when one finished, and this one dies to say so.
//!
//! **Completion is one long-lived shell, and it never runs your code.** The
//! opposite call, for the opposite reason: `TabExpansion2` costs about 2s the
//! first time it is asked for a command name (it builds the command cache) and
//! single-digit milliseconds afterwards, so a process per keystroke is not a
//! feature that works. It is deliberately *not* the floating shell's session,
//! which is the obvious economy and is wrong: that shell is busy running your
//! build, and completion queued behind a ten-minute `cargo build` is completion
//! that does not exist.
//!
//! Probed 2026-08-18 against PowerShell 7 over pipes, which is where the shape
//! of all of this comes from:
//!
//! ```text
//! 'Get-Chi'            n=1  1919ms   ← the command cache, built once
//! 'Get-Chi' (again)    n=1     3ms
//! 'ls src/l'           n=1     7ms   ReplacementIndex=3 Length=5
//! 'Get-ChildItem -Pa'  n=1     1ms   ReplacementIndex=14 Length=3  -Path
//! 'git sta'            n=0    98ms   ← nothing, and see the rule for why
//! ```
//!
//! The spans are the payload. PowerShell says *what it would replace* as well as
//! what with, so nothing on the front end has to work out how much of `src/li`
//! a path completion eats — see `.claude/rules/bang.md`.

use std::collections::HashMap;
use std::io::Write;
use std::process::{Child, ChildStdin};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::servers::{jobs, pump_lines};
use crate::shell::{launch, prime_command};

/* ── what a run says on the wire ──────────────────────────────────────────── */

#[derive(Clone, Serialize)]
struct BangOut {
    id: String,
    /// A batch, never a line — see `crate::sluice`. stdout and stderr in the
    /// order they were read, which is the order the transcript line keeps.
    lines: Vec<String>,
    /// Lines that went by faster than the wall draws and were left out.
    skipped: usize,
}

/// The most lines one `bang:out` batch carries: the transcript line's own cap
/// (`BANG_LINES` in `bang.ts`), so nothing is left out that it would have kept.
const BANG_BATCH: usize = 400;

/// The end of a run.
///
/// `code` is `None` for a run that was stopped, and that is a distinction rather
/// than a convenience: killing a process on Windows gives it an exit code like
/// any other, so a stopped run arrives wearing every mark of a failed one. The
/// same trap `wasStopped` disarms for a turn, one subsystem over — a card must
/// not read rust for something you did on purpose.
#[derive(Clone, Serialize)]
struct BangDone {
    id: String,
    code: Option<i32>,
}

/* ── runs ─────────────────────────────────────────────────────────────────── */

struct Run {
    child: Child,
    /// A `!` line spawns builds which spawn compilers, exactly as the floating
    /// shell does. Taken and dropped by `bang_stop`, because dropping it is what
    /// takes the tree down (`KILL_ON_JOB_CLOSE`) — `child.kill()` alone reaches
    /// only the `pwsh` at the top of it.
    job: Option<jobs::Job>,
    /// Set before the killing starts, and read once both streams have closed.
    /// Without it a stop is reported as whatever code the kill produced.
    stopped: AtomicBool,
}

#[derive(Default)]
pub struct Bangs {
    runs: Mutex<HashMap<String, Run>>,
    completer: Mutex<Option<Completer>>,
}

/// Run one line in `cwd`, streaming what it says back under `id`.
///
/// `async`, and every blocking step inside `off_main` — spawning a process is
/// tens of milliseconds on a good day and seconds on a cold one, and doing it
/// on the thread that drains the event loop would stop every card on the wall
/// being painted for that long. See the rule in CLAUDE.md; this is the exact
/// shape `azdo_runs` was got wrong in.
#[tauri::command]
pub async fn bang_run(
    app: AppHandle,
    id: String,
    cwd: String,
    text: String,
) -> Result<String, String> {
    crate::off_main(move || {
        /* One run per card. A second `!` while the first is going is a request
           to run the second, so the first goes down rather than the two of them
           interleaving their output into one transcript line. */
        stop_run(&app, &id);

        let (program, mut child) = launch(&cwd)?;

        let job = jobs::Job::new();
        if let Some(j) = &job {
            j.assign(child.id());
        }

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let mut stdin = child.stdin.take();

        /* Primed the same way the floating shell is, and for the same two
           reasons: 5.1 hands a redirected stdout the OEM code page, and
           PowerShell draws progress by steering a cursor we have not got. */
        if let Some(w) = stdin.as_mut() {
            let _ = w.write_all(prime_command().as_bytes());
            let body = text.replace("\r\n", "\n").replace('\r', "\n");
            let _ = w.write_all(body.as_bytes());
            let _ = w.write_all(b"\n");
            let _ = w.flush();
        }
        /* And then EOF, which is the whole protocol. `-Command -` runs what it
           has been given and exits when stdin closes; holding it open is how
           you get a shell that sits there having done the work and never says
           it is finished. */
        drop(stdin);

        /* Registered *before* the pumps are started, and that ordering is the
           whole of a bug worth stating: `!true` prints nothing and exits at
           once, so both pipes can close — and `finish_if_last` run — before this
           insert had happened. It would find no entry, conclude by elimination
           that the run had been stopped, and report a clean command as stopped.
           Nothing may look for the entry until it is there. */
        app.state::<Bangs>().runs.lock().unwrap().insert(
            id.clone(),
            Run {
                child,
                job,
                stopped: AtomicBool::new(false),
            },
        );

        /* Both streams have to close before the run is over, so the exit is
           claimed by whichever of them is last. Counted rather than joined:
           these threads are detached, and a thread parked on a `join` is one
           the shutdown path would have to know about. */
        let left = Arc::new(AtomicUsize::new(2));
        let spout = outlet(&app, &id);
        if let Some(out) = stdout {
            pump_into(app.clone(), id.clone(), left.clone(), out, spout.clone());
        } else {
            finish_if_last(&app, &id, &left);
        }
        if let Some(err) = stderr {
            pump_into(app.clone(), id.clone(), left.clone(), err, spout.clone());
        } else {
            finish_if_last(&app, &id, &left);
        }
        drop(spout);

        Ok(program)
    })
    .await?
}

/// Pump one of a run's two streams, and give up its share of the count when it
/// closes.
///
/// Generic rather than a trait object because `pump_lines` takes `&mut R` with
/// `R: Read` — a `&mut dyn Read` is unsized and will not fit it.
fn pump_into<R: std::io::Read + Send + 'static>(
    app: AppHandle,
    id: String,
    left: Arc<AtomicUsize>,
    mut reader: R,
    spout: crate::sluice::Sluice<String>,
) {
    std::thread::spawn(move || {
        pump_lines(&mut reader, |line| spout.push(line));
        /* What was read goes out before `bang:done` says the run is over. */
        spout.flush();
        drop(spout);
        finish_if_last(&app, &id, &left);
    });
}

/// A run's door to the wall: `bang:out` at most ten times a second, however
/// fast the command prints. A `!` aimed at a log follower or a runaway loop is
/// exactly the case — one emit per line is what froze the wall once.
fn outlet(app: &AppHandle, id: &str) -> crate::sluice::Sluice<String> {
    let app = app.clone();
    let id = id.to_string();
    crate::sluice::Sluice::open(
        crate::sluice::Spec {
            name: "bang:out",
            cap: Some(BANG_BATCH),
            period: std::time::Duration::from_millis(100),
            flood: None,
        },
        move |lines, skipped| {
            let _ = app.emit_to("main", "bang:out", BangOut { id: id.clone(), lines, skipped });
        },
        |_, _| {},
    )
}

/// Reap the child and say how it went — but only for the last stream to close.
///
/// The wait happens *outside* the map's lock, which is the load-bearing half:
/// the entry is removed first and waited on afterwards, so a run that takes a
/// while to die does not hold the mutex that `bang_stop` needs to kill it.
fn finish_if_last(app: &AppHandle, id: &str, left: &Arc<AtomicUsize>) {
    if left.fetch_sub(1, Ordering::SeqCst) != 1 {
        return;
    }
    let taken = app.state::<Bangs>().runs.lock().unwrap().remove(id);
    let code = match taken {
        Some(mut run) => {
            let status = run.child.wait().ok().and_then(|s| s.code());
            if run.stopped.load(Ordering::SeqCst) {
                None
            } else {
                status
            }
        }
        /* Already gone: `bang_stop` reaped it. Nothing else removes an entry,
           so this is a stop by elimination. */
        None => None,
    };
    let _ = app.emit(
        "bang:done",
        BangDone {
            id: id.to_string(),
            code,
        },
    );
}

/// Take a run down, and everything it started with it.
///
/// Leaves the entry in the map on purpose. The streams closing is what ends a
/// run, and letting that path do the reaping and the reporting keeps one exit
/// for every start — a stop that emitted its own `bang:done` would race the one
/// the pipes are about to emit and draw the run twice.
fn stop_run(app: &AppHandle, id: &str) {
    /* The state guard is bound rather than chained, because the lock borrows
       from it and a temporary would be dropped at the end of the statement that
       took it — with the lock still held. */
    let bangs = app.state::<Bangs>();
    let mut map = bangs.runs.lock().unwrap();
    if let Some(run) = map.get_mut(id) {
        run.stopped.store(true, Ordering::SeqCst);
        /* The job first, since that is what reaches the compilers underneath.
           `kill` is the backstop, and the only thing there is off Windows. */
        drop(run.job.take());
        let _ = run.child.kill();
    }
}

/// Kill whatever this card is running. Idempotent — nothing to stop is the
/// state the gesture was asking for.
#[tauri::command]
pub async fn bang_stop(app: AppHandle, id: String) -> Result<(), String> {
    crate::off_main(move || stop_run(&app, &id)).await
}

#[tauri::command]
pub fn bang_running(bangs: State<'_, Bangs>, id: String) -> bool {
    bangs.runs.lock().unwrap().contains_key(&id)
}

/* ── completion ───────────────────────────────────────────────────────────── */

/// What a completion reply is recognised by, on its way back out of the shell.
///
/// The same `\u{1}` the floating shell's marker uses and for the same reason —
/// no output has any business emitting it — but a different word, because the
/// two protocols must not be able to answer each other.
const COMP_HEAD: &str = "\u{1}skcomp\u{1}";

/// One request's reply, as PowerShell writes it. Short keys because this is one
/// line of JSON per keystroke and none of it is read by a person.
#[derive(Deserialize)]
struct RawReply {
    i: i64,
    l: i64,
    #[serde(default)]
    m: Vec<RawMatch>,
}

#[derive(Deserialize)]
struct RawMatch {
    t: String,
    #[serde(default)]
    k: String,
    #[serde(default)]
    d: Option<String>,
}

/// What the dock is offered. Field names are the front end's (`bang.ts`'s
/// `Match`), not PowerShell's.
#[derive(Clone, Serialize)]
pub struct CompMatch {
    text: String,
    label: String,
    kind: String,
}

/// What the shell would replace, and with what.
#[derive(Clone, Serialize)]
pub struct Completion {
    index: usize,
    length: usize,
    matches: Vec<CompMatch>,
}

struct Completer {
    stdin: ChildStdin,
    child: Child,
    _job: Option<jobs::Job>,
    /// Requests that have gone out and not come back, by number. Shared with
    /// the reader thread, which is the only thing that ever answers one.
    waiting: Arc<Mutex<HashMap<u64, Sender<Option<RawReply>>>>>,
    next: u64,
}

/// How long a completion is waited for.
///
/// Generous because the *first* one can be: the command cache is built on
/// demand (1919ms, probed) and a profile that registers argument completers is
/// read before that. Every one after is single-digit milliseconds, so this
/// ceiling is only ever paid once — and paying it is better than a Tab that
/// gives up just before the shell was about to answer.
const COMP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

/// How many matches are asked for. A popup shows a handful; the rest are a
/// bigger JSON line per keystroke and nothing that gets read.
const COMP_MATCHES: usize = 60;

/// Escape a string for a PowerShell **single-quoted** literal.
///
/// Doubling the quote is the whole of it — a single-quoted string in PowerShell
/// interprets nothing else, which is exactly why the request is built out of
/// them. Newlines go too: the protocol is one line per request, and a pasted
/// two-line command would otherwise be read as two statements, the second of
/// them unquoted.
fn ps_quote(text: &str) -> String {
    text.replace('\'', "''")
        .replace(['\r', '\n'], " ")
}

/// The one line that asks for one completion.
///
/// `Set-Location` first, so a relative path completes against the card's
/// directory rather than wherever the completer happens to be standing —
/// probed, and it is the difference between `src/l` offering `src/lib` and
/// offering nothing. `-ErrorAction SilentlyContinue` because a card whose
/// directory has been deleted under it should complete badly rather than break
/// the shell that does all the completing.
#[cfg(windows)]
fn complete_request(req: u64, cwd: &str, script: &str, col: usize) -> String {
    let head = format!("[char]1 + 'skcomp' + [char]1 + '{req}' + [char]1");
    format!(
        "try {{ Set-Location -LiteralPath '{cwd}' -ErrorAction SilentlyContinue; \
         $c = TabExpansion2 -inputScript '{script}' -cursorColumn {col}; \
         $o = @{{ i = $c.ReplacementIndex; l = $c.ReplacementLength; \
         m = @($c.CompletionMatches | Select-Object -First {COMP_MATCHES} | ForEach-Object \
         {{ @{{ t = $_.CompletionText; k = [string]$_.ResultType; d = $_.ListItemText }} }}) }}; \
         Write-Output ({head} + (ConvertTo-Json -Compress -Depth 4 -InputObject $o)) }} \
         catch {{ Write-Output ({head} + 'null') }}\n",
        cwd = ps_quote(cwd),
        script = ps_quote(script),
    )
}

/// Split a reply line into the request it answers and its body.
fn read_reply(line: &str) -> Option<(u64, &str)> {
    let at = line.find(COMP_HEAD)?;
    let rest = &line[at + COMP_HEAD.len()..];
    let (req, body) = rest.split_once('\u{1}')?;
    Some((req.parse().ok()?, body))
}

/// Start the completion shell, or hand back the one already running.
///
/// The profile is loaded, which is the same call the floating shell makes and
/// here it buys something specific: `Register-ArgumentCompleter` is how `git`,
/// `dotnet` and friends learn to complete their own subcommands, and it lives
/// in a profile. Without one there are none — probed, `git sta` offers nothing.
/// So a machine whose profile registers them completes them here too, for free,
/// and one whose does not pays 0.6s of startup it would have paid anyway.
#[cfg(windows)]
fn ensure_completer(slot: &mut Option<Completer>) -> Result<&mut Completer, String> {
    /* A completer whose shell has died is not a completer. Checked before it is
       handed out, or the first Tab after a crash writes into a closed pipe and
       waits eight seconds to be told nothing. */
    let gone = match slot.as_mut() {
        /* `Ok(None)` is the one answer that means "still running". */
        Some(c) => !matches!(c.child.try_wait(), Ok(None)),
        None => true,
    };
    if gone {
        *slot = None;
    } else {
        return Ok(slot.as_mut().unwrap());
    }

    /* Started where the app is. Every request sets its own directory, so this
       one is only ever the shell's first breath. */
    let (_, mut child) = launch(".")?;
    let job = jobs::Job::new();
    if let Some(j) = &job {
        j.assign(child.id());
    }

    let stdout = child.stdout.take().ok_or("the completer has no stdout")?;
    let stderr = child.stderr.take();
    let mut stdin = child.stdin.take().ok_or("the completer takes no input")?;

    let waiting: Arc<Mutex<HashMap<u64, Sender<Option<RawReply>>>>> =
        Arc::new(Mutex::new(HashMap::new()));

    {
        let waiting = waiting.clone();
        let mut out = stdout;
        std::thread::spawn(move || {
            pump_lines(&mut out, |line| {
                /* Everything that is not a reply is dropped without a word.
                   A profile prints its own banner, and this shell has no panel
                   to print one into. */
                let Some((req, body)) = read_reply(&line) else {
                    return;
                };
                let reply = serde_json::from_str::<RawReply>(body).ok();
                if let Some(tx) = waiting.lock().unwrap().remove(&req) {
                    let _ = tx.send(reply);
                }
            });
            /* The shell ending strands everyone still waiting, and a strand is
               an eight-second Tab. Answering them with nothing is the honest
               end: `ensure_completer` will start another for the next one. */
            for (_, tx) in waiting.lock().unwrap().drain() {
                let _ = tx.send(None);
            }
        });
    }

    /* Drained and discarded. Not because nothing goes to stderr — a profile
       complains there — but because a pipe nobody reads fills up and stops the
       shell, and there is no panel here for the complaint to appear in. */
    if let Some(mut err) = stderr {
        std::thread::spawn(move || pump_lines(&mut err, |_| {}));
    }

    stdin
        .write_all(prime_command().as_bytes())
        .map_err(|e| format!("the completer would not start: {e}"))?;
    /* Warm the command cache now rather than on your first Tab. Request 0 is
       nobody's — the reply is dropped for want of anyone waiting on it, which
       is exactly what it is for. */
    let _ = stdin.write_all(complete_request(0, ".", "Get-Ch", 6).as_bytes());
    let _ = stdin.flush();

    *slot = Some(Completer {
        stdin,
        child,
        _job: job,
        waiting,
        next: 1,
    });
    Ok(slot.as_mut().unwrap())
}

/// What the shell would offer for this line, at this caret.
///
/// `off_main`, and it has to be for two separate reasons: it parks on a channel
/// waiting for the reply, and it holds the completer's mutex while writing the
/// request. Either one on the main thread is the whole wall stopping.
#[cfg(windows)]
#[tauri::command]
pub async fn bang_complete(
    app: AppHandle,
    cwd: String,
    line: String,
    cursor: usize,
) -> Result<Completion, String> {
    crate::off_main(move || {
        let rx: Receiver<Option<RawReply>> = {
            let bangs = app.state::<Bangs>();
            let mut slot = bangs.completer.lock().unwrap();
            let comp = ensure_completer(&mut slot)?;
            let req = comp.next;
            comp.next += 1;
            let (tx, rx) = channel();
            comp.waiting.lock().unwrap().insert(req, tx);
            let col = cursor.min(line.chars().count());
            let ask = complete_request(req, &cwd, &line, col);
            comp.stdin
                .write_all(ask.as_bytes())
                .and_then(|_| comp.stdin.flush())
                .map_err(|e| {
                    comp.waiting.lock().unwrap().remove(&req);
                    format!("the completer stopped listening: {e}")
                })?;
            rx
            /* And the lock goes here, before the wait. Holding it across the
               reply would make completion serial with itself: the next
               keystroke's request could not be written until this one had been
               answered, which is the opposite of what a debounce is for. */
        };

        let reply = rx
            .recv_timeout(COMP_TIMEOUT)
            .map_err(|_| "the shell did not answer in time".to_string())?;

        Ok(shape(reply))
    })
    .await?
}

/// Nothing to offer, rather than nothing at all.
///
/// `TabExpansion2` is PowerShell's, and there is no equivalent worth pretending
/// to on a platform that has not got it — a home-grown path completer would
/// answer differently from the shell that is about to run the line, which is
/// worse than answering nothing. The dock draws an empty list as no popup, so
/// this degrades to a Tab that does nothing rather than to an error.
#[cfg(not(windows))]
#[tauri::command]
pub async fn bang_complete(
    _app: AppHandle,
    _cwd: String,
    _line: String,
    _cursor: usize,
) -> Result<Completion, String> {
    Ok(Completion {
        index: 0,
        length: 0,
        matches: Vec::new(),
    })
}

/// Turn a reply into what the dock reads, and a missing one into an empty
/// offering.
///
/// `null` is what the request's own `catch` writes, and it arrives for ordinary
/// reasons — a half-typed string the parser will not take, a directory that has
/// gone. None of those is an error worth raising into the UI; all of them mean
/// there is nothing to complete.
fn shape(reply: Option<RawReply>) -> Completion {
    let Some(raw) = reply else {
        return Completion {
            index: 0,
            length: 0,
            matches: Vec::new(),
        };
    };
    Completion {
        /* Negative is what PowerShell answers with when it has no span at all.
           Clamped rather than rejected: the matches may still be good, and an
           index of zero with a length of zero is an insertion at the caret. */
        index: raw.i.max(0) as usize,
        length: raw.l.max(0) as usize,
        matches: raw
            .m
            .into_iter()
            .map(|m| CompMatch {
                label: m
                    .d
                    .filter(|d| !d.is_empty())
                    .unwrap_or_else(|| m.t.clone()),
                text: m.t,
                kind: m.k,
            })
            .collect(),
    }
}

impl Bangs {
    /// Every run and the completer die with the app, along with whatever they
    /// started — the same promise dev servers, project runs and shells make.
    pub fn shutdown(&self) {
        for (_, mut run) in self.runs.lock().unwrap().drain() {
            run.stopped.store(true, Ordering::SeqCst);
            drop(run.job.take());
            let _ = run.child.kill();
            let _ = run.child.wait();
        }
        if let Some(mut comp) = self.completer.lock().unwrap().take() {
            let _ = comp.stdin.flush();
            let _ = comp.child.kill();
            let _ = comp.child.wait();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_ordinary_line_is_not_a_reply() {
        assert!(read_reply("").is_none());
        assert!(read_reply("skcomp 4 {}").is_none());
        /* The floating shell's marker must not be read as one of these. The
           whole point of a second word. */
        assert!(read_reply("\u{1}skein\u{1}0\u{1}C:\\atelier").is_none());
    }

    #[test]
    fn a_reply_carries_the_request_it_answers() {
        let (req, body) = read_reply("\u{1}skcomp\u{1}7\u{1}{\"i\":4}").unwrap();
        assert_eq!(req, 7);
        assert_eq!(body, "{\"i\":4}");
    }

    #[test]
    fn a_half_written_reply_is_left_alone() {
        assert!(read_reply("\u{1}skcomp\u{1}7").is_none());
        assert!(read_reply("\u{1}skcomp\u{1}").is_none());
    }

    #[test]
    fn output_in_front_of_a_reply_does_not_hide_it() {
        /* Same hazard the shell's marker has: something that printed without a
           newline leaves its last word on the front of our line. */
        let (req, body) = read_reply("noise\u{1}skcomp\u{1}2\u{1}null").unwrap();
        assert_eq!(req, 2);
        assert_eq!(body, "null");
    }

    #[test]
    fn a_quote_cannot_end_the_string_it_is_inside() {
        /* The one escape a PowerShell single-quoted literal has. Get this wrong
           and `!echo 'it's'` is a syntax error at best and a second statement
           at worst. */
        assert_eq!(ps_quote("it's"), "it''s");
        assert_eq!(ps_quote("plain"), "plain");
    }

    #[test]
    fn a_newline_cannot_split_one_request_into_two() {
        assert_eq!(ps_quote("a\r\nb"), "a  b");
        assert!(!ps_quote("a\nb").contains('\n'));
    }

    #[cfg(windows)]
    #[test]
    fn a_request_is_exactly_one_line() {
        let ask = complete_request(3, "C:\\a b", "cat 'x'", 7);
        assert!(ask.ends_with('\n'), "the shell would never run it");
        assert_eq!(ask.matches('\n').count(), 1, "one request, one line");
        assert!(ask.contains("TabExpansion2"));
        assert!(ask.contains("C:\\a b"), "the directory was lost");
    }

    #[test]
    fn nothing_to_complete_is_an_empty_offering_rather_than_a_failure() {
        /* `null` is what the request's own catch writes, and it arrives for
           ordinary reasons — a half-typed string, a directory that has gone. */
        let empty = shape(None);
        assert_eq!(empty.matches.len(), 0);
        assert_eq!(empty.index, 0);
    }

    #[test]
    fn a_match_falls_back_to_what_would_be_inserted() {
        let shaped = shape(Some(RawReply {
            i: 4,
            l: 2,
            m: vec![
                RawMatch {
                    t: ".\\src\\lib".into(),
                    k: "ProviderContainer".into(),
                    d: Some("lib".into()),
                },
                RawMatch {
                    t: "Get-ChildItem".into(),
                    k: "Command".into(),
                    d: None,
                },
            ],
        }));
        assert_eq!(shaped.index, 4);
        assert_eq!(shaped.length, 2);
        /* The leaf is what gets drawn, and the whole path is what gets
           inserted. */
        assert_eq!(shaped.matches[0].label, "lib");
        assert_eq!(shaped.matches[0].text, ".\\src\\lib");
        /* No ListItemText: the label is the insertion, which is better than a
           row with nothing in it. */
        assert_eq!(shaped.matches[1].label, "Get-ChildItem");
    }

    #[test]
    fn a_span_the_shell_could_not_work_out_is_clamped_rather_than_trusted() {
        /* PowerShell answers -1 when it has no span. As a usize that is
           enormous, and every completion would then be applied at an index the
           line has not got. */
        let shaped = shape(Some(RawReply {
            i: -1,
            l: -1,
            m: Vec::new(),
        }));
        assert_eq!(shaped.index, 0);
        assert_eq!(shaped.length, 0);
    }
}
