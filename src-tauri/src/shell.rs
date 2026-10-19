//! The shell that floats over the wall.
//!
//! One long-lived `pwsh` (or `powershell`, or `sh`) reading commands off its
//! stdin, with both its streams pumped back as lines. It is deliberately *not*
//! a terminal emulator and deliberately not a PTY, which is the opposite call
//! from the one dev servers made — see `.claude/rules/shell.md`. The short of
//! it: ConPTY is broken on this machine, every `openpty` child dies at
//! `0xC0000142` before it runs, and a floating terminal that cannot start a
//! shell is worse than a line-oriented console that can.
//!
//! Because nothing here is a terminal, the shell prints no prompt of its own
//! (probed 2026-08-17 against PowerShell 7 with `-Command -` over pipes: no
//! prompt, no echo, output streamed line by line as it happened, SGR colour
//! intact). Skein draws the prompt instead, which means it has to be *told*
//! where the shell is and whether the last command worked. That is the marker
//! below: after every command we write a second line that prints the exit
//! status and `$PWD`, recognise it on the way back out, and turn it into a
//! `shell:done` rather than into output. The PowerShell in it stays here, next
//! to the argv it belongs with; the front end never learns that a marker
//! exists.

use std::collections::HashMap;
use std::io::Write;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::servers::{jobs, pump_lines};

/* ── the marker ───────────────────────────────────────────────────────────── */

/// `\u{1}` because it is a byte no command's output has any business emitting,
/// and because it survives every encoding the shells here might pick.
const MARK: char = '\u{1}';
/// What a marker line begins with. Searched for rather than matched at the
/// start: a command that ends without a newline (`Write-Host -NoNewline`)
/// leaves its last word on the front of ours.
const MARK_HEAD: &str = "\u{1}skein\u{1}";

/// Split a pumped line into whatever output came before the marker, whether the
/// command succeeded, and where the shell now is.
///
/// `None` when the line carries no marker, which is the overwhelming majority.
fn read_mark(line: &str) -> Option<(&str, bool, &str)> {
    let at = line.find(MARK_HEAD)?;
    let (before, rest) = line.split_at(at);
    let rest = &rest[MARK_HEAD.len()..];
    let (code, cwd) = rest.split_once(MARK)?;
    Some((before, code == "0", cwd))
}

/// The line written after every command, whose whole job is to be recognised.
///
/// `$?` is captured into a variable first because it is clobbered by the next
/// thing evaluated, and building the string would be that next thing. It is
/// `$?` rather than `$LASTEXITCODE` because it is the one that means "the thing
/// I just typed worked" for a cmdlet and for a native exe alike.
#[cfg(windows)]
fn mark_command() -> String {
    format!(
        "$__skein_ok = $?; Write-Output ([char]1 + 'skein' + [char]1 + $(if ($__skein_ok) {{'0'}} else {{'1'}}) + [char]1 + $PWD.Path)\n"
    )
}

#[cfg(not(windows))]
fn mark_command() -> String {
    "__skein_ok=$?; printf '\\001skein\\001%s\\001%s\\n' \"$__skein_ok\" \"$PWD\"\n".to_string()
}

/// Run before anything you type, and never shown.
///
/// UTF-8 out, because Windows PowerShell 5.1 otherwise hands a redirected
/// stdout the OEM code page and every box-drawing character in a build's output
/// arrives as mojibake. No progress bars, because PowerShell renders those by
/// steering a cursor we have not got — over a pipe they are a screenful of
/// escape sequences per web request.
#[cfg(windows)]
pub(crate) fn prime_command() -> &'static str {
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $ProgressPreference = 'SilentlyContinue'\n"
}

#[cfg(not(windows))]
pub(crate) fn prime_command() -> &'static str {
    "PS1=''\n"
}

/* ── runtime state ────────────────────────────────────────────────────────── */

struct Shell {
    /// What it turned out to be. Held rather than re-derived because whoever
    /// attaches next has to be told, and by then there is nothing left to ask.
    program: String,
    child: Child,
    /// Taken at spawn and held for the life of the shell: closing it is EOF,
    /// and EOF is how `-Command -` decides it has been told everything.
    stdin: Option<ChildStdin>,
    /// A shell spawns builds which spawn compilers. Dropping this takes the
    /// whole tree, exactly as it does for a dev server.
    _job: Option<jobs::Job>,
}

#[derive(Default)]
pub struct Shells(Mutex<HashMap<String, Shell>>);

#[derive(Clone, Serialize)]
struct ShellOut {
    id: String,
    /// A batch, never a line — see `crate::sluice` and `outlet` below.
    lines: Vec<OutLine>,
    /// Lines that went by faster than the console draws and were left out.
    skipped: usize,
}

#[derive(Clone, Serialize)]
struct OutLine {
    line: String,
    stderr: bool,
}

/// The most lines one `shell:out` batch carries: the console's own scrollback
/// (`SCROLLBACK` in `shell.ts`, 1,200) less the one line that says how many
/// were skipped — a full batch plus that line would push the line straight out.
const SHELL_BATCH: usize = 1_199;

/// A shell's door to the wall. `tail -f` on a busy log, or a loop that never
/// ends, is a shell printing as fast as it can — and one emit per line is what
/// froze the wall once (`crate::sluice`).
fn outlet(app: &AppHandle, id: &str) -> crate::sluice::Sluice<OutLine> {
    let app = app.clone();
    let id = id.to_string();
    crate::sluice::Sluice::open(
        crate::sluice::Spec {
            name: "shell:out",
            cap: Some(SHELL_BATCH),
            period: std::time::Duration::from_millis(100),
            flood: None,
        },
        move |lines, skipped| {
            let _ = app.emit_to("main", "shell:out", ShellOut { id: id.clone(), lines, skipped });
        },
        |_, _| {},
    )
}

#[derive(Clone, Serialize)]
struct ShellDone {
    id: String,
    ok: bool,
    cwd: String,
}

#[derive(Clone, Serialize)]
struct ShellExit {
    id: String,
    code: Option<i32>,
}

/// What `open_shell` answers with.
///
/// `started` is the difference between having spawned a shell and having found
/// one, and it is reported rather than inferred because only the caller can be
/// wrong about it: a front end that had just attached to a session running
/// somewhere else would otherwise print "pwsh in <the directory I asked for>",
/// which is a claim about a directory that shell may have left long ago.
#[derive(Clone, Serialize)]
pub struct ShellInfo {
    program: String,
    started: bool,
}

/* ── starting one ─────────────────────────────────────────────────────────── */

/// No console window flashing up behind a GUI app — the same shape
/// `actions.rs` and `project.rs` use, and needed here for the same reason.
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

pub(crate) fn build(name: &str, cwd: &str) -> Command {
    let mut cmd = Command::new(name);
    #[cfg(windows)]
    {
        /* `-Command -` is the mode that reads statement by statement off stdin
           and runs each as it arrives; `-File -` waits for EOF and would show
           nothing until the shell was closed. The profile is deliberately
           loaded — `ll` and every other alias you have is what makes this your
           shell rather than a box that happens to run commands — and it is why
           the panel says `starting` until the first marker lands. Probed
           2026-08-17: this profile takes about 4s, against 0.5s for
           `-NoProfile`, and prints a line of its own on the way. */
        cmd.args(["-NoLogo", "-Command", "-"]);
    }
    #[cfg(not(windows))]
    {
        cmd.args(["-s"]);
    }
    cmd.current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    /* Keep the colour that would otherwise be dropped for want of a tty. */
    cmd.env("FORCE_COLOR", "1");
    cmd.env("CLICOLOR_FORCE", "1");
    /* There is no terminal here to answer a credential prompt, so a repo whose
       token expired must fail rather than hang forever behind a question
       nobody can see. The same pair `azdo.rs` and `project.rs` set, for the
       same reason — this is only foreground in the sense that you typed it. */
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    quiet(&mut cmd);
    cmd
}

/// pwsh, then powershell. Which one you got is reported rather than assumed:
/// the two differ in enough places (encoding, `$PSStyle`, half the cmdlets)
/// that a panel claiming the wrong one would be lying about what it runs.
#[cfg(windows)]
pub(crate) fn launch(cwd: &str) -> Result<(String, Child), String> {
    let mut last = String::new();
    for name in ["pwsh", "powershell"] {
        match build(name, cwd).spawn() {
            Ok(child) => return Ok((name.to_string(), child)),
            Err(e) => last = format!("{name}: {e}"),
        }
    }
    Err(format!("no shell could be started — {last}"))
}

#[cfg(not(windows))]
pub(crate) fn launch(cwd: &str) -> Result<(String, Child), String> {
    let name = std::env::var("SHELL").unwrap_or_else(|_| "sh".into());
    let child = build(&name, cwd)
        .spawn()
        .map_err(|e| format!("{name}: {e}"))?;
    Ok((name, child))
}

/// Open a shell in `cwd`, or hand back the one already open under this id.
///
/// Returns what it is called, which is what the panel's header says.
///
/// **Attaching to a shell that is already running is the normal case, not an
/// error.** Toggling the panel shut leaves it running on purpose, and in dev
/// every front-end edit rebuilds `App.svelte` and with it the object that was
/// holding this session — so a second `open_shell` against a live id has to
/// find that session rather than refuse or, worse, start a second shell in a
/// directory you had already left. It is answered with a fresh marker instead
/// of with a spawn, which is what tells the new attachment where the old one
/// had got to: the reattach path and the first-open path then look identical
/// from the front end, and neither has a case the other has not got.
#[tauri::command]
pub fn open_shell(
    app: AppHandle,
    shells: State<'_, Shells>,
    id: String,
    cwd: String,
) -> Result<ShellInfo, String> {
    {
        let mut map = shells.0.lock().unwrap();
        if let Some(sh) = map.get_mut(&id) {
            if let Some(w) = sh.stdin.as_mut() {
                let _ = w.write_all(mark_command().as_bytes());
                let _ = w.flush();
            }
            return Ok(ShellInfo {
                program: sh.program.clone(),
                started: false,
            });
        }
    }

    let (name, mut child) = launch(&cwd)?;

    let job = jobs::Job::new();
    if let Some(j) = &job {
        j.assign(child.id());
    }

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let mut stdin = child.stdin.take();

    /* Both streams, because PowerShell does all of its complaining on stderr
       and half of what you run does too. */
    let spout = outlet(&app, &id);
    if let Some(mut out) = stdout {
        let app = app.clone();
        let id = id.clone();
        let spout = spout.clone();
        std::thread::spawn(move || {
            pump_lines(&mut out, |text| {
                /* The marker is the one line that is not output. Anything in
                   front of it on the same line is, though — a command that
                   ended without a newline leaves its last word there. */
                if let Some((before, ok, cwd)) = read_mark(&text) {
                    if !before.is_empty() {
                        spout.push(OutLine { line: before.to_string(), stderr: false });
                    }
                    /* The command's output goes out before the prompt that
                       ends it, or the console marks the wrong line failed. */
                    spout.flush();
                    let _ = app.emit(
                        "shell:done",
                        ShellDone {
                            id: id.clone(),
                            ok,
                            cwd: cwd.to_string(),
                        },
                    );
                    return;
                }
                spout.push(OutLine { line: text, stderr: false });
            });
            spout.flush();
            drop(spout);
            /* stdout ending is the shell ending, and the panel has to say so
               rather than sit there taking input nothing will read. */
            let _ = app.emit("shell:exit", ShellExit { id, code: None });
        });
    }

    if let Some(mut err) = stderr {
        let spout = spout.clone();
        std::thread::spawn(move || {
            pump_lines(&mut err, |text| spout.push(OutLine { line: text, stderr: true }));
        });
    }
    drop(spout);

    /* Prime it, then mark — so the first thing the panel hears is where the
       shell is, which is also the first moment it is ready for anything. */
    if let Some(w) = stdin.as_mut() {
        let _ = w.write_all(prime_command().as_bytes());
        let _ = w.write_all(mark_command().as_bytes());
        let _ = w.flush();
    }

    shells.0.lock().unwrap().insert(
        id,
        Shell {
            program: name.clone(),
            child,
            stdin,
            _job: job,
        },
    );

    Ok(ShellInfo {
        program: name,
        started: true,
    })
}

/// Send a line — or several — and ask for the marker behind them.
#[tauri::command]
pub fn shell_send(shells: State<'_, Shells>, id: String, text: String) -> Result<(), String> {
    let mut map = shells.0.lock().unwrap();
    let sh = map.get_mut(&id).ok_or("no shell is open")?;
    let w = sh.stdin.as_mut().ok_or("the shell is not taking input")?;
    /* Normalised, because a paste off this wall arrives with CRLFs and the
       shell reads one command per newline. */
    let body = text.replace("\r\n", "\n").replace('\r', "\n");
    w.write_all(body.as_bytes())
        .and_then(|_| w.write_all(b"\n"))
        .and_then(|_| w.write_all(mark_command().as_bytes()))
        .and_then(|_| w.flush())
        .map_err(|e| format!("the shell stopped listening: {e}"))
}

/// Take the shell down, and everything it started with it.
///
/// This is also what "stop" means in the panel: there is no console attached to
/// these processes, so there is no `Ctrl+C` to send them — `GenerateConsoleCtrl
/// Event` needs a console the child shares, and a GUI app's children have none.
/// Killing the tree and opening a fresh shell in the same directory is the
/// honest version of that gesture, and the panel says so in those words.
#[tauri::command]
pub fn close_shell(shells: State<'_, Shells>, id: String) -> Result<(), String> {
    if let Some(mut sh) = shells.0.lock().unwrap().remove(&id) {
        /* Closing stdin first gives a shell sitting idle the chance to end the
           way it would in a terminal, before it is killed for taking too long
           about it. */
        drop(sh.stdin.take());
        let _ = sh.child.kill();
        let _ = sh.child.wait();
    }
    Ok(())
}

#[tauri::command]
pub fn shell_alive(shells: State<'_, Shells>, id: String) -> bool {
    shells.0.lock().unwrap().contains_key(&id)
}

impl Shells {
    /// Every shell dies with the app, along with whatever it was running — the
    /// same promise dev servers and project runs make.
    pub fn shutdown(&self) {
        let mut map = self.0.lock().unwrap();
        for (_, mut sh) in map.drain() {
            drop(sh.stdin.take());
            let _ = sh.child.kill();
            let _ = sh.child.wait();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_ordinary_line_carries_no_marker() {
        assert!(read_mark("").is_none());
        assert!(read_mark("  Directory: C:\\atelier\\skein").is_none());
        // The word alone is not the marker; the control characters are.
        assert!(read_mark("skein").is_none());
    }

    #[test]
    fn a_marker_says_whether_it_worked_and_where_it_is() {
        let (before, ok, cwd) = read_mark("\u{1}skein\u{1}0\u{1}C:\\atelier\\skein").unwrap();
        assert_eq!(before, "");
        assert!(ok);
        assert_eq!(cwd, "C:\\atelier\\skein");

        let (_, ok, _) = read_mark("\u{1}skein\u{1}1\u{1}C:\\atelier").unwrap();
        assert!(!ok, "a failed command was reported as a success");
    }

    #[test]
    fn a_path_with_spaces_in_it_survives() {
        let (_, _, cwd) =
            read_mark("\u{1}skein\u{1}0\u{1}C:\\Program Files\\Epic Games\\UE_5.8").unwrap();
        assert_eq!(cwd, "C:\\Program Files\\Epic Games\\UE_5.8");
    }

    #[test]
    fn output_that_ended_without_a_newline_is_not_swallowed_by_the_marker() {
        /* `Write-Host -NoNewline "working"` leaves its word on the front of the
           next thing written, and that word is output rather than punctuation. */
        let (before, ok, cwd) = read_mark("working\u{1}skein\u{1}0\u{1}C:\\atelier").unwrap();
        assert_eq!(before, "working");
        assert!(ok);
        assert_eq!(cwd, "C:\\atelier");
    }

    #[test]
    fn a_half_written_marker_is_left_alone_rather_than_half_read() {
        // Nothing after the status: no directory, so no marker yet.
        assert!(read_mark("\u{1}skein\u{1}0").is_none());
        assert!(read_mark("\u{1}skein\u{1}").is_none());
    }

    #[test]
    fn the_marker_command_asks_for_what_the_marker_carries() {
        let cmd = mark_command();
        assert!(cmd.ends_with('\n'), "the shell would never run it");
        /* $? is read into a variable before anything else is evaluated — the
           whole reason this is two statements rather than one expression. */
        assert!(cmd.contains("$__skein_ok"));
    }
}
