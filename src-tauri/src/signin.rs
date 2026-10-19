//! Signing an account in, without a terminal.
//!
//! One gesture: `claude auth login --claudeai` with
//! `CLAUDE_SECURESTORAGE_CONFIG_DIR` pointed at the account's store, so the CLI
//! writes the credential itself and nothing is ever pasted into Skein. What is
//! here is only the plumbing — `accounts.rs` owns where a store lives and
//! `.claude/rules/accounts.md` is the reasoning for all of it.
//!
//! ### Why this is pipes, where the old flow needed a window
//!
//! The previous sign-in opened a real terminal, and the reason it gave was
//! sound for the command it ran: `claude setup-token` is an ink TUI, it emits
//! nothing at all on pipes and never exits (probed 2026-08-19), and the obvious
//! answer of a PTY is closed on this machine — ConPTY kills every `openpty`
//! child at `0xC0000142`, which `servers.md` and `shell.md` both record at
//! length.
//!
//! **`claude auth login` is not that command.** Probed 2026-08-20 with pipes for
//! all three streams and no console at all: it writes
//!
//! ```text
//! Opening browser to sign in…
//! If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?…
//! Paste code here if prompted >
//! ```
//!
//! and sits there alive, waiting on stdin. Plain `process.stdout.write` and a
//! readline over stdin rather than a rendered interface, so there is nothing a
//! terminal was providing. The constraint was inherited from the sibling command
//! rather than measured for this one.
//!
//! ### The two ways it finishes, and why both are handled
//!
//! The flow opens the browser to a `http://localhost:<port>/callback` redirect
//! and runs a one-shot server for it, so the ordinary path completes with no
//! input at all: the browser comes back, the CLI writes the store and exits.
//!
//! The URL it *prints* is a different one — the manual redirect at
//! `platform.claude.com/oauth/code/callback` — and it is the fallback for a
//! browser that cannot reach localhost. That path ends with a `code#state`
//! pasted back, which is what `paste_signin` writes to the child's stdin. Both
//! are handled because the printed URL is the visible one, so a person following
//! what is on screen ends up on the manual path whether or not the automatic one
//! would have worked.
//!
//! ### The prompt is the one line with no newline on it
//!
//! `Paste code here if prompted > ` is unterminated, and it is the piece of
//! output the fallback depends on. `servers::pump_lines` would hold it until the
//! stream ended — it emits an unterminated remainder only at EOF, which here is
//! after the sign-in is over. So this module reads **chunks** and hands them
//! over as they arrive, accumulating the text rather than the lines. The front
//! end matches against the whole of it (`signin.ts`), which is also what makes
//! it robust to the wording moving.
//!
//! ### What must not be logged
//!
//! That URL carries a live PKCE `code_challenge` and `state`. It goes to the
//! webview, because showing it is the entire point of the fallback, and it goes
//! nowhere else — no log, no snapshot, no database. Same rule `limits.rs`
//! follows for a credential, one step further out: what is on screen for you to
//! act on is not the same as what is written down.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::servers::jobs;

/* ── what is in flight ─────────────────────────────────────────────────────*/

struct Session {
    /// Held for the life of the sign-in: the fallback writes a code to it, and
    /// dropping it is EOF, which is how a cancel gets the readline to give up.
    stdin: Option<std::process::ChildStdin>,
    /// `claude` spawns a `node` under itself and the flow binds a local port.
    /// Dropping this takes the tree, exactly as it does for a dev server — a
    /// cancelled sign-in that left a callback server holding a port would be
    /// the next sign-in failing for no visible reason.
    _job: Option<jobs::Job>,
    /// Everything the child has said so far, so a panel that was closed and
    /// reopened mid-sign-in can be shown what it missed rather than an empty
    /// box. Bounded, because it is a String in a mutex on a wall that may be
    /// open all day.
    out: String,
    running: bool,
}

/// Sign-ins in flight, one per account label. Keyed rather than single because
/// two accounts can be set up at once and neither should have to wait.
#[derive(Default)]
pub struct Signins(Mutex<HashMap<String, Session>>);

/// Enough of a session's output to hold a URL and a prompt several times over,
/// and far short of a wall's worth of memory.
const MAX_OUT: usize = 16 * 1024;

#[derive(Clone, Serialize)]
struct SigninOut {
    label: String,
    text: String,
}

#[derive(Clone, Serialize)]
struct SigninDone {
    label: String,
    /// Whether the process exited cleanly. Not the same question as the next
    /// one, and both are reported: a clean exit that wrote nothing is a
    /// sign-in somebody abandoned in the browser.
    ok: bool,
    signed_in: bool,
}

/// One in-flight sign-in as the panel sees it, for a panel that has just
/// mounted and missed the events so far.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SigninState {
    pub label: String,
    pub running: bool,
    pub out: String,
}

/* ── starting one ──────────────────────────────────────────────────────────*/

/// No console window flashing up behind a GUI app — the same shape `shell.rs`,
/// `actions.rs` and `project.rs` use, and the whole difference between this and
/// the terminal it replaces.
#[cfg(windows)]
fn quiet(cmd: &mut Command) -> &mut Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW)
}
#[cfg(not(windows))]
fn quiet(cmd: &mut Command) -> &mut Command {
    cmd
}

/// Read whatever arrives, as it arrives, and hand it over.
///
/// Chunks rather than lines, for the reason in this file's header: the prompt
/// that the paste fallback depends on carries no terminator, so anything
/// waiting for one holds it back until the sign-in is already over. Invalid
/// UTF-8 degrades to a replacement character rather than killing the pump, and
/// a multi-byte character split across two reads is the one cost of chunking —
/// accepted here because this output is ASCII but for an ellipsis, and a
/// mangled ellipsis is not worth a decoder.
fn pump_chunks<R: Read>(reader: &mut R, mut emit: impl FnMut(String)) {
    let mut buf = [0u8; 2048];
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => emit(String::from_utf8_lossy(&buf[..n]).into_owned()),
        }
    }
}

/// Start a sign-in for one account.
///
/// Returns as soon as the child is up. Everything after that arrives as
/// `signin:out` and one `signin:done` — there is no completion to wait for here,
/// since what is being waited on is somebody in a browser.
#[tauri::command]
pub fn begin_signin(
    app: AppHandle,
    state: State<'_, Signins>,
    label: String,
) -> Result<(), String> {
    start(&app, &state, label)
}

/// Start one sign-in. The command above, and a sign-in another wall asked for
/// (`begin_for_afar`), both come through here, so a sign-in started from the
/// other laptop is the same child, the same pipes and the same events as one
/// started from this panel — and this wall's panel draws it as it goes.
fn start(app: &AppHandle, state: &Signins, label: String) -> Result<(), String> {
    let app = app.clone();
    if !crate::accounts::is_label(&label) {
        return Err("an account name may use letters, digits, dot, dash and underscore".into());
    }
    /* Already going: say so rather than starting a second browser round trip
       for the same account, which would leave two flows racing for one store. */
    if state
        .0
        .lock()
        .map_err(|_| "the sign-ins are wedged".to_string())?
        .get(&label)
        .is_some_and(|s| s.running)
    {
        return Err(format!("'{label}' is already signing in"));
    }

    let dir = crate::accounts::store_dir(&app, &label)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not make the account store: {e}"))?;

    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("no home dir: {e}"))?;

    let mut cmd = Command::new(crate::claude::program(&home));
    cmd.args(["auth", "login", "--claudeai"])
        .env("CLAUDE_SECURESTORAGE_CONFIG_DIR", &dir)
        /* The CLI reads this ahead of any store, so one inherited from Skein's
           own environment would sign in over the top of a token nobody meant to
           use — the same removal `supervisor.rs` makes for the same reason. */
        .env_remove("CLAUDE_CODE_OAUTH_TOKEN")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    quiet(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not start the sign-in: {e}"))?;

    let job = jobs::Job::new();
    if let Some(j) = &job {
        j.assign(child.id());
    }

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdin = child.stdin.take();

    {
        let mut map = state
            .0
            .lock()
            .map_err(|_| "the sign-ins are wedged".to_string())?;
        map.insert(
            label.clone(),
            Session {
                stdin,
                _job: job,
                out: String::new(),
                running: true,
            },
        );
    }

    /* Both streams, and boxed to one type so they can share a pump:
       `ChildStdout` and `ChildStderr` are different types and will not sit in
       an array together. `Box<dyn Read>` is itself `Read`, which is what lets
       `pump_chunks` stay generic — the trap `servers.rs` notes about a bare
       `&mut dyn Read` being unsized.

       Both because the flow says what it is doing on stdout and complains on
       stderr, and a sign-in that failed is exactly the case where the complaint
       is the whole of what you need. They are not distinguished downstream: the
       panel is showing you what the sign-in said, and which pipe a sentence
       came out of is not a thing anybody reading it needs to know. */
    let readers: Vec<Box<dyn Read + Send>> = [
        stdout.map(|r| Box::new(r) as Box<dyn Read + Send>),
        stderr.map(|r| Box::new(r) as Box<dyn Read + Send>),
    ]
    .into_iter()
    .flatten()
    .collect();

    for mut reader in readers {
        let app = app.clone();
        let label = label.clone();
        std::thread::spawn(move || {
            pump_chunks(&mut reader, |text| {
                if let Ok(mut map) = app.state::<Signins>().0.lock() {
                    if let Some(s) = map.get_mut(&label) {
                        s.out.push_str(&text);
                        /* Trimmed from the front, so what is dropped when a
                           sign-in gets chatty is the oldest text rather than
                           the URL and the prompt, which are what anybody needs.
                           On a character boundary, since `out` is a String and
                           slicing one anywhere else panics — and the boundary is
                           found forwards from the cut, so the result is never
                           longer than the cap. */
                        if s.out.len() > MAX_OUT {
                            let mut cut = s.out.len() - MAX_OUT;
                            while cut < s.out.len() && !s.out.is_char_boundary(cut) {
                                cut += 1;
                            }
                            s.out = s.out[cut..].to_string();
                        }
                    }
                }
                let _ = app.emit(
                    "signin:out",
                    SigninOut {
                        label: label.clone(),
                        text,
                    },
                );
            });
        });
    }

    std::thread::spawn(move || {
        let ok = child.wait().map(|s| s.success()).unwrap_or(false);
        /* Asked of the store rather than inferred from the exit code, because
           the two genuinely differ: a flow abandoned in the browser can still
           exit 0 having written nothing, and that is a sign-in that did not
           happen however politely it ended. */
        let signed_in = crate::accounts::signed_in(&app, &label);
        /* Who it now signs in as, while the token is as fresh as it will ever
           be: that is what the other walls match the account on, and what lets
           this row take the settings they agreed while it could not be told
           apart (`accountsync::adopt_identity`). This thread is off the main
           one already. A failure costs a line under the row, and the next
           allowance read asks again. */
        if signed_in {
            if let Err(e) = crate::limits::learn_now(&app, &label) {
                log::debug!("accounts: could not learn who '{label}' is after its sign-in: {e}");
            }
        }
        if let Ok(mut map) = app.state::<Signins>().0.lock() {
            if let Some(s) = map.get_mut(&label) {
                s.running = false;
                /* Closed now rather than at cancel: the readline is gone with
                   the process, and a pipe held open to a dead child is a write
                   that fails later for a reason nobody can trace. */
                s.stdin = None;
            }
        }
        let _ = app.emit(
            "signin:done",
            SigninDone {
                label,
                ok,
                signed_in,
            },
        );
    });

    Ok(())
}

/* ── signed in from another wall ───────────────────────────────────────────
 *
 * The replacement for carrying a sign-in between machines, which is gone
 * because a refresh token rotates (accounts.md, *A sign-in never leaves its
 * machine*). A person at another wall asks this one to sign an account in; this
 * wall runs its own `claude auth login` exactly as its panel would, and hands
 * back the address the CLI printed — the **manual** authorize URL, whose
 * redirect is the platform's page that shows a code, since this machine's
 * localhost is unreachable from a browser on the other one. The person signs in
 * there and pastes the `code#state` into their own panel; it comes back here
 * and goes into the child's stdin, the paste fallback this file already has.
 *
 * **The PKCE verifier never leaves this machine** — it is in the child's memory
 * and nowhere else — so what crossed (a challenge and a state out, a one-time
 * code back) is useless anywhere but here, and the token pair the CLI then
 * writes is this machine's own chain. Nothing about a credential crosses.
 *
 * Both halves are a person's and answered on the same stream
 * (`link/accounting.rs`); no tool reaches them. Each waits a bounded while on
 * the child, inside the asker's twenty-second exchange, and says so if the
 * child is slower than that rather than guessing.
 */

/// How long to wait for the child to print its address.
const URL_WITHIN: std::time::Duration = std::time::Duration::from_secs(12);
/// How long to wait for the child to finish once it has the code.
const DONE_WITHIN: std::time::Duration = std::time::Duration::from_secs(14);

/// Sign `label` in on this machine for a person at `host`, and hand back the
/// address to finish it at. Refuses an account this wall does not have; picks
/// up a sign-in already running for it rather than racing a second one.
pub fn begin_for_afar(app: &AppHandle, label: &str, host: &str) -> Result<String, String> {
    let known = app
        .try_state::<crate::store::Store>()
        .and_then(|s| s.0.lock().ok().map(|c| crate::accounts::registry(app, &c)))
        .unwrap_or_default();
    if !known.iter().any(|s| s.label == label) {
        let names: Vec<&str> = known.iter().map(|s| s.label.as_str()).collect();
        return Err(format!("there is no account called {label:?} on this wall — it has {}", if names.is_empty() { "none".to_string() } else { names.join(", ") }));
    }
    let state = app.state::<Signins>();
    let running = state.0.lock().map(|m| m.get(label).is_some_and(|s| s.running)).unwrap_or(false);
    if !running {
        start(app, &state, label.to_string())?;
        log::info!("accounts: a sign-in for '{label}' was started from {host}");
    }
    let until = std::time::Instant::now() + URL_WITHIN;
    loop {
        let (out, still) = state
            .0
            .lock()
            .map(|m| m.get(label).map(|s| (s.out.clone(), s.running)).unwrap_or_default())
            .unwrap_or_default();
        if let Some(url) = crate::flyway::accounts::authorize_url(&out) {
            return Ok(url);
        }
        if !still {
            return Err(format!("the sign-in for {label} ended before it printed an address{}", last_line(&out)));
        }
        if std::time::Instant::now() >= until {
            return Err(format!(
                "the sign-in for {label} started but printed no address in time — its row in the accounts panel on that wall shows what it is doing"
            ));
        }
        std::thread::sleep(std::time::Duration::from_millis(150));
    }
}

/// Hand a code pasted at another wall to the sign-in waiting here, and say how
/// it ended: `signed in`, `refused` (with the CLI's own last words), or
/// `pending` if the child is still exchanging it.
pub fn code_for_afar(app: &AppHandle, label: &str, code: &str) -> (String, Option<String>) {
    let state = app.state::<Signins>();
    let written = (|| -> Result<(), String> {
        let mut map = state.0.lock().map_err(|_| "the sign-ins are wedged".to_string())?;
        let session = map
            .get_mut(label)
            .filter(|s| s.running)
            .ok_or_else(|| format!("{label} is not signing in on this wall any more — start it again"))?;
        let w = session.stdin.as_mut().ok_or_else(|| "that sign-in is not taking input".to_string())?;
        w.write_all(format!("{code}\n").as_bytes())
            .and_then(|_| w.flush())
            .map_err(|e| format!("could not hand the code over: {e}"))
    })();
    if let Err(why) = written {
        return ("refused".into(), Some(why));
    }
    let until = std::time::Instant::now() + DONE_WITHIN;
    loop {
        let (out, still) = state
            .0
            .lock()
            .map(|m| m.get(label).map(|s| (s.out.clone(), s.running)).unwrap_or_default())
            .unwrap_or_default();
        if !still {
            return if crate::accounts::signed_in(app, label) {
                ("signed in".into(), None)
            } else {
                ("refused".into(), Some(format!("the sign-in did not take{}", last_line(&out))))
            };
        }
        if std::time::Instant::now() >= until {
            return ("pending".into(), Some("still exchanging the code — the row will say when it is done".into()));
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
}

/// The last thing the child said, as a clause — what a refusal is worth
/// quoting, since the CLI answers a bad code with a bare "Invalid code".
///
/// **Never a line with an address in it.** The authorize URL carries a live PKCE
/// challenge and state, which go to the screen they are for and nowhere else
/// (*What must not be logged*, accounts.md) — and a refusal is sent to another
/// wall. The first cut quoted the URL line as the reason, found on the lab run:
/// the CLI answers a pasted code on the *same* line as its unterminated prompt,
/// so the line that held the answer was the one filtered out as "the prompt",
/// and the last line left was the address. So what follows the last prompt is
/// read first.
fn last_line(out: &str) -> String {
    const PROMPT: &str = "prompted >";
    let lower = out.to_ascii_lowercase();
    let after = lower.rfind(PROMPT).map(|i| out[i + PROMPT.len()..].trim()).unwrap_or("");
    let said = if !after.is_empty() && !after.contains("http") {
        Some(after.lines().map(str::trim).filter(|l| !l.is_empty()).collect::<Vec<_>>().join(" "))
    } else {
        out.lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.to_ascii_lowercase().contains("paste code") && !l.contains("http"))
            .next_back()
            .map(str::to_string)
    };
    said.map(|l| format!(": {}", crate::clip::preview(&l, 300))).unwrap_or_default()
}

#[cfg(test)]
mod last_line_tests {
    use super::last_line;

    #[test]
    fn a_refusal_quotes_the_cli_and_never_the_address() {
        let out = "Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?state=SECRET\nPaste code here if prompted > OAuth error: Invalid code\n";
        assert_eq!(last_line(out), ": OAuth error: Invalid code");
        let silent = "Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?state=SECRET\nPaste code here if prompted > ";
        assert_eq!(last_line(silent), ": Opening browser to sign in…");
        assert!(!last_line(silent).contains("SECRET"));
        assert_eq!(last_line(""), "");
    }
}

/* ── the fallback ──────────────────────────────────────────────────────────*/

/// Hand a `code#state` to a waiting sign-in.
///
/// The manual path, for a browser that could not reach the localhost callback.
/// Written to the child's stdin with a newline, which is what its readline is
/// waiting for; the CLI does the splitting on `#` and says so itself when the
/// code is malformed, so nothing here validates the shape beyond it not being
/// empty. Better its complaint than ours — it knows what it asked for.
#[tauri::command]
pub fn paste_signin(
    state: State<'_, Signins>,
    label: String,
    code: String,
) -> Result<(), String> {
    let code = code.trim().to_string();
    if code.is_empty() {
        return Err("nothing to paste".into());
    }
    let mut map = state
        .0
        .lock()
        .map_err(|_| "the sign-ins are wedged".to_string())?;
    let session = map
        .get_mut(&label)
        .filter(|s| s.running)
        .ok_or_else(|| format!("'{label}' is not signing in"))?;
    let w = session
        .stdin
        .as_mut()
        .ok_or_else(|| "that sign-in is not taking input".to_string())?;
    w.write_all(format!("{code}\n").as_bytes())
        .and_then(|_| w.flush())
        .map_err(|e| format!("could not hand the code over: {e}"))
}

/// Give up on a sign-in.
///
/// Dropping the session drops both the job — which takes the child and the
/// callback server holding a port with it — and stdin, whose EOF is what gets
/// the readline to stop on a platform with no job objects. Two mechanisms
/// because one of them is `#[cfg(windows)]`.
#[tauri::command]
pub fn cancel_signin(state: State<'_, Signins>, label: String) -> Result<(), String> {
    state
        .0
        .lock()
        .map_err(|_| "the sign-ins are wedged".to_string())?
        .remove(&label);
    Ok(())
}

/// Every sign-in this process knows about, running or lately finished.
///
/// For a panel that has just mounted: the events it missed are not replayed, so
/// what it gets instead is the accumulated text, which is all those events added
/// up to anyway.
#[tauri::command]
pub fn signin_states(state: State<'_, Signins>) -> Result<Vec<SigninState>, String> {
    let map = state
        .0
        .lock()
        .map_err(|_| "the sign-ins are wedged".to_string())?;
    Ok(map
        .iter()
        .map(|(label, s)| SigninState {
            label: label.clone(),
            running: s.running,
            out: s.out.clone(),
        })
        .collect())
}
