//! The hooks Skein hands its cards, and the filter mode that serves them.
//!
//! One hook so far, and it exists to undo a bug in the tool it is handed to.
//!
//! # The Bash tool halves runs of backslashes
//!
//! Measured 2026-08-21 against claude 2.1.233 on Windows, by comparing three
//! points for the same tool call: what the API emitted (the transcript record),
//! what a `PreToolUse` hook was handed, and what arrived on disk. Something
//! between the tool call and the shell puts the `command` string through one
//! left-to-right `\\` → `\` pass. A heredoc of known runs:
//!
//! ```text
//! emitted  1  2  3  4  5  6
//! arrived  1  1  2  2  3  3        i.e. ceil(n/2)
//! ```
//!
//! **It is not the shell**, and that is the part that cost four sessions a
//! workaround each. Every one of them wrote a correctly *quoted* heredoc
//! (`<<'EOF'`), which does no backslash processing whatsoever, and blamed the
//! heredoc anyway — the collapse also hits single-quoted arguments and one-line
//! commands, so bash never had the chance. Nor is it a JSON or C unescape:
//! `\n`, `\"`, `\$`, `` \` `` and a lone backslash all arrive intact.
//!
//! There is one exception, and it is why `compensate` scans runs instead of
//! calling `.replace("\\\\", "\\")`: **a run immediately followed by `"` is
//! passed through whole.** That is what made
//! `awk '{ gsub(/\\/,"\\") }'` arrive as `gsub(/\/,"\\")` — the first pair
//! halved, the second, sitting against a quote, not. Measured: runs of 1, 2, 3
//! and 4 before a `"` all survive; before `'`, before a letter, and at end of
//! line they halve. A single quote does not protect, so `"` is the whole of the
//! rule.
//!
//! Why it is worth carrying code for: the failure is silent. The command
//! succeeds, the file is written, and the damage surfaces later as a path with
//! one backslash where two were meant —
//! `new Database(APPDATA + "\\dev.skein.studio\\skein.db")` reached disk as
//! `"\dev…"` and only announced itself as `SQLITE_CANTOPEN`. Four sessions
//! across three repositories hit it between 2026-08-11 and 2026-08-21, each
//! diagnosed it as the heredoc, each reached for the Write tool instead, and
//! none of them left a note.
//!
//! # Why the compensator is in this binary
//!
//! A `PreToolUse` hook fires on *every* Bash call of every card, so its startup
//! cost is a tax on the whole wall: this is ~5ms, a Python script measured ~50ms
//! and PowerShell 5.1 is upwards of 200ms. It also removes the question of what
//! is installed — a machine that has just downloaded Skein need not also have an
//! interpreter, which is the entire point of the fix travelling with the app.
//!
//! The hook is handed over in the `--settings` layer `supervisor` already passes,
//! so **nothing outside Skein is written**. The cost of that choice, chosen
//! deliberately: a `claude` run from a terminal on the same machine still eats
//! backslashes. Fixing that would mean Skein editing `~/.claude/settings.json`,
//! and this is not an app that writes to the user's global config — see
//! `accounts.rs`, which goes out of its way to hold none of it.
//!
//! The two layers were measured not to compound, which is what makes the split
//! safe rather than a trap: with a compensating hook in *both* the user's
//! settings and the flag layer, the result was one doubling, not two. Hooks from
//! different sources are handed the original input, so the last `updatedInput`
//! wins rather than chaining. If they had chained, every backslash on a machine
//! with a global hook installed would have quadrupled.
//!
//! # When to take this out
//!
//! The day the Bash tool stops halving backslashes, this starts *adding* them.
//! `compensate` is exercised by `cargo test` against a model of the collapse,
//! which cannot see an upstream fix — only a live probe can. The check is one
//! throwaway session; `.claude/rules/hooks.md` spells it out.
//!
//! **That day arrived from a direction nobody was watching**, and it is why this
//! module now decides two things per call rather than one. Probed 2026-08-25
//! against claude 2.1.241 on this machine (`tools/probe-deny.ts`, and the
//! matrix beside it):
//!
//! - The Windows shell tool is called **`PowerShell`**, not `Bash`. The hook was
//!   registered with `matcher: "Bash"`, so it fired on nothing at all — the
//!   compensator had been dead for however long that had been true, silently,
//!   because nothing anywhere announces that a matcher stopped matching. Both
//!   names are live on this one machine simultaneously: a card Skein spawned is
//!   holding a `Bash` tool while a fresh `claude` gets `PowerShell`.
//! - The PowerShell tool **does not collapse backslashes**. Emitted and arrived
//!   were byte-identical for runs of 2, 4, 6 and 8. So the fix is not to widen
//!   the matcher to both names: compensating a PowerShell command would double
//!   every backslash in it, which is this section's own warning coming true.
//!
//! Hence the shape. The hook is registered against **every** tool, so it cannot
//! be silently switched off by a rename again, and both questions are answered
//! in `reply` where they can be tested: is this a shell call at all (does it
//! carry a `command`), and is it the one tool known to eat backslashes.
//!
//! # The one git index behind a shared working tree
//!
//! The second thing this hook does, and the reason it now knows which card it
//! belongs to. Cards standing in one working tree share one git *index*, so
//! `git add <the paths this work touched>` — the discipline every rule in this
//! repository asks for — stages into an index a sibling has already staged
//! into, and `git commit` with no pathspec commits all of it. `bare_commit` and
//! `sweep` are the guard; `store::foreign_staged` is the evidence. See sink
//! 8d3dab75 for the five commits in 2m14s that paid for it.
//!
//! Probed at the same time, because the whole design rests on it: a
//! `permissionDecision: "deny"` from a `PreToolUse` hook **does** stop a tool
//! call on a card spawned with `--dangerously-skip-permissions`, and the reason
//! string reaches the model. Bypass mode skips the asking, not the hooks. Had
//! that gone the other way the guard would have had to be a warning injected as
//! context, which is a different design rather than a different line.

use std::io::Read;

/// The argument that turns this binary into a hook filter instead of an app.
///
/// Deliberately not a bare `--hook`: the string appears in the argv of every
/// card's `claude`, and the next person to read it there deserves to know which
/// hook without opening this file.
pub const FLAG: &str = "--bash-hook";

/// Double every run of backslashes the Bash tool will halve, and leave the ones
/// it will not.
///
/// The exact inverse of the measured collapse: an unprotected run of n becomes
/// 2n, which arrives as `ceil(2n / 2)` = n, for every n. A run against a `"` is
/// left alone because it arrives whole already. Doubling never changes which
/// character follows a run, so the two cases cannot interfere with each other.
///
/// A run at the very end of the string is doubled, with the rest: nothing
/// follows it, so it is not against a quote. The case is unobservable in
/// practice — a command whose last character is a backslash is a line
/// continuation at end of input, which bash rejects before any of this matters.
pub fn compensate(command: &str) -> String {
    let bytes = command.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;

    while i < bytes.len() {
        if bytes[i] != b'\\' {
            /* Copied as a byte rather than a char. `\` is ASCII and every
               continuation byte of a multi-byte sequence is >= 0x80, so a byte
               scan cannot split a character, and the only bytes this ever
               duplicates are ASCII backslashes. */
            out.push(bytes[i]);
            i += 1;
            continue;
        }

        let start = i;
        while i < bytes.len() && bytes[i] == b'\\' {
            i += 1;
        }
        let run = &bytes[start..i];

        out.extend_from_slice(run);
        if bytes.get(i) != Some(&b'"') {
            out.extend_from_slice(run);
        }
    }

    /* Infallible by construction, per the note above; `from_utf8_lossy` would
       quietly corrupt a command rather than saying so, and a panic here would
       be a card unable to run any shell command at all. */
    String::from_utf8(out).unwrap_or_else(|_| command.to_string())
}

/// Serve the hook if that is what we were started for. Returns whether it was.
///
/// **Fails open, always.** Unreadable stdin, unparseable JSON, an input shape
/// that is not what a `PreToolUse` payload should be: print nothing and exit 0,
/// which leaves the original command untouched. The bug this compensates for is
/// silent and occasional; a filter that refused a call it could not parse would
/// be a card that cannot run shell commands, which is neither.
///
/// Called from `main` before anything else, so a hook invocation never creates a
/// window and never joins the wall. Nothing between here and `run()` may be
/// given side effects without moving this check above them.
///
/// It *may* now read the studio database, which the first version of this note
/// said it never would. The line that mattered is intact and is the reason the
/// wording changed rather than the rule: `store::open_readonly` opens the file
/// read-only and runs no migration, so a hook is a reader of a database the app
/// owns and never a second thing that could wedge it. See `sweep`.
pub fn intercept() -> bool {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if !args.iter().any(|a| a == FLAG) {
        return false;
    }

    let mut raw = String::new();
    if std::io::stdin().read_to_string(&mut raw).is_err() {
        return true;
    }

    if let Some(out) = reply(&raw, after(&args, FLAG_CARD), after(&args, FLAG_DB)) {
        print!("{out}");
    }
    true
}

/// The value given after a flag, if it was given at all.
fn after<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    let at = args.iter().position(|a| a == flag)?;
    args.get(at + 1).map(String::as_str).filter(|v| !v.is_empty())
}

/// The pure-ish half of `intercept`: a hook payload in, the reply to print out,
/// or `None` for "say nothing", which is how a hook declines to change anything.
///
/// **The guard is asked first, because a denied call is not a call to rewrite.**
/// The two answers occupy the same `hookSpecificOutput` and mean different
/// things — one hands back a corrected input, the other stops the call — so
/// there is an order and this is it. Compensating a command that is about to be
/// refused would also be work done for nothing.
fn reply(raw: &str, card: Option<&str>, db: Option<&str>) -> Option<String> {
    let payload: serde_json::Value = serde_json::from_str(raw).ok()?;

    /* **Which hook this is, decided here rather than by a matcher.** Three
       events are registered now and all three are registered against
       everything, for the reason recorded at the top of this file: a matcher is
       a tool or event name written into configuration where no test can reach
       it, and when it stops matching it says nothing at all. So the routing is
       code.

       A payload with no `hook_event_name` falls through to the `PreToolUse`
       body below, which is what a build that does not send the field should
       get — the shape check there (does the input carry a `command`) was the
       whole discriminator before this arm existed and still works on its own. */
    match payload.get("hook_event_name").and_then(serde_json::Value::as_str) {
        Some("UserPromptSubmit") | Some("SessionStart") => {
            return standing(&payload, card, db);
        }
        _ => {}
    }

    let mut input = payload.get("tool_input")?.as_object()?.clone();

    /* **A shell tool is one with a `command`, not one with a name.** The hook is
       registered against every tool now (see `settings`), so this is where a
       `Read` or an `Edit` leaves — and it leaves on the shape of what it was
       handed rather than on a list of names, which is the same decision made
       once instead of every time the CLI adds a tool. */
    let command = input.get("command")?.as_str()?;

    if let (Some(card), Some(db)) = (card, db) {
        let cwd = payload.get("cwd").and_then(serde_json::Value::as_str);
        if let Some(reason) = sweep(command, cwd, card, std::path::Path::new(db)) {
            return Some(
                serde_json::json!({
                    "hookSpecificOutput": {
                        "hookEventName": "PreToolUse",
                        "permissionDecision": "deny",
                        "permissionDecisionReason": reason,
                    }
                })
                .to_string(),
            );
        }
    }

    /* **The collapse is the Bash tool's, and only the Bash tool's.** Probed
       2026-08-25 against 2.1.241: the PowerShell tool hands the hook exactly
       what the API emitted — runs of 2, 4, 6 and 8 all arrive whole — so
       compensating one would *double* every backslash in it. That is the
       failure the "when to take this out" note at the top of this file warns
       about, arriving from a direction nobody expected: not the Bash tool being
       fixed, but a second shell tool that never had the bug. Named rather than
       shape-checked, because there is no way to tell from a payload whether the
       thing about to run it eats backslashes. */
    if payload.get("tool_name").and_then(serde_json::Value::as_str) != Some("Bash") {
        return None;
    }

    /* The overwhelming majority of commands contain no backslash at all. Saying
       nothing is cheaper than handing back an identical input for the CLI's
       schema validator to check, and it keeps the hook off the permission
       machinery's books for every such call. */
    if !command.contains('\\') {
        return None;
    }

    let fixed = compensate(command);
    if fixed == command {
        return None;
    }

    input.insert("command".into(), serde_json::Value::String(fixed));
    Some(
        serde_json::json!({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "updatedInput": input,
            }
        })
        .to_string(),
    )
}

/// The `--settings` layer every card is spawned with.
///
/// Inline JSON rather than a file: there is nothing to write, nothing to clean
/// up, and nothing for a half-installed machine to be missing. `--settings` is
/// the flag tier, which merges over the user's own settings rather than
/// replacing them — a card keeps the model, effort and plugins configured on the
/// machine.
///
/// The hook is given in the **exec form** (`command` plus `args`), which spawns
/// the executable directly with no shell in between. That is not tidiness: the
/// shell form would put an installation path through a shell parser, and a path
/// containing a space, a `$` or a quote is exactly the class of bug this whole
/// module exists to compensate for. Verified present in 2.1.233 before being
/// relied on — a build that ignored `args` would run this binary with no
/// arguments, which is to say it would open a second Skein for every shell
/// command a card ran.
///
/// `card` is the conversation id and the studio directory, and it is what turns
/// the shared-index guard on. `None` leaves the hook doing only what it did
/// before — compensating backslashes — which is what a caller with no card to
/// name should get rather than a guard that does not know whose commit it is
/// looking at. The id is baked in here, once, rather than looked up per call:
/// see `FLAG_CARD`.
pub fn settings(chat: bool, card: Option<(&str, &std::path::Path)>) -> String {
    let mut root = serde_json::Map::new();

    /* The permissions a chat card is granted, and the whole of them. Moved here
       from `supervisor::CHAT_SETTINGS` when the settings layer stopped being a
       chat-only argument; the reasoning is its, and still holds.

       `--tools` decides *which* tools exist; this decides whether the two that
       do are allowed to run. Both are needed, and the second is easy to miss
       because its absence looks like the model choosing not to search: probed
       against 2.1.233 with `--tools WebSearch,WebFetch` and no permission
       argument at all, a plain "search the web for X" came back refused. With
       this it answers.

       Deliberately an allow rule rather than `--dangerously-skip-permissions`,
       which would also work — with no file or shell tool in the process there is
       nothing for a bypass to unlock. It is spelled out anyway so that the one
       card on the wall that is *provably* harmless is not also the one carrying
       the most dangerous flag Skein knows, where the next person to read the
       argv has to reconstruct why that is fine. */
    if chat {
        root.insert(
            "permissions".into(),
            serde_json::json!({ "allow": ["WebSearch", "WebFetch"] }),
        );
    }

    /* No exe, no hook — and a chat card still gets its permissions. The cards
       run uncompensated, which is where they were before this existed. */
    if let Ok(exe) = std::env::current_exe() {
        let mut args = vec![FLAG.to_string()];
        if let Some((id, dir)) = card {
            args.push(FLAG_CARD.to_string());
            args.push(id.to_string());
            args.push(FLAG_DB.to_string());
            args.push(dir.join("skein.db").to_string_lossy().into_owned());
        }
        /* One entry, three events. The binary and the argv are identical for all
           of them — `reply` routes on `hook_event_name`, which is the whole
           point of registering broad — so building the object once and naming it
           three times is not a shortcut, it is the thing that makes a fourth
           event cost one line and no chance of the three drifting apart. */
        let entry = serde_json::json!({
            "hooks": [{
                "type": "command",
                "command": exe.to_string_lossy(),
                "args": args,
                "timeout": 10,
            }],
        });
        root.insert(
            "hooks".into(),
            serde_json::json!({
                /* The compaction, which is the precise moment a card loses track
                   of its own background work, and the prompt, which is the
                   moment it is most likely to be *asked* about it. Both measured
                   firing under Skein's argv, and `additionalContext` measured
                   reaching the model from both — `tools/probe-jobs.ts`. Neither
                   carries a matcher, for the reason the one below does not.

                   These are cheap in the case that matters: `standing` prints
                   nothing at all unless the `job` table has a row for this
                   session, which for most cards is never. */
                "SessionStart": [entry],
                "UserPromptSubmit": [entry],
                "PreToolUse": [{
                    /* **No matcher, and that is the whole of a bug this module
                       shipped with.** It was `"Bash"`, which is the name the
                       Windows shell tool had when this was written and does not
                       have now: probed 2026-08-25 against 2.1.241, a fresh
                       `claude` on this machine calls it `PowerShell`, so the
                       matcher matched nothing and every hook here was a silent
                       no-op — for however many versions it had been true, since
                       nothing announces that a matcher stopped matching. Both
                       names are live on this machine at once, which is what
                       decides it: a matcher is a name written down twice, and
                       the copy in the settings layer cannot be tested. Firing on
                       everything and leaving in `reply` costs a process per tool
                       call — ~5ms, measured — and cannot rot. */
                    "hooks": [{
                        "type": "command",
                        "command": exe.to_string_lossy(),
                        "args": args,
                        "timeout": 10,
                    }],
                }],
            }),
        );
    }

    serde_json::Value::Object(root).to_string()
}

/* ── the one git index behind a shared working tree ───────────────────────── */

/// The card this hook belongs to, and where the wall keeps its record of who
/// wrote what.
///
/// Both are baked into the card's own `--settings` layer by `settings`, rather
/// than worked out here from the payload's `session_id`. Two reasons, and the
/// second is the one that decided it: a session id has to be looked up in the
/// database to become a card, which is a query to find out who is asking before
/// any question has been asked — and `agent_session_id` moves under a card every
/// time it is resumed, so the lookup has a window in which it answers nothing.
/// The id is a constant of the process the settings layer was built for.
///
/// `--db` for the same reason `identifier` is not spelled here: the path to the
/// studio database is `app_data_dir()`'s to know, and a hook process has no
/// Tauri app to ask. Passing it keeps the `dev.skein.studio` string in the one
/// place `tauri.conf.json` already puts it.
pub const FLAG_CARD: &str = "--card";
pub const FLAG_DB: &str = "--db";

/// A `git commit` with nothing naming what it should commit.
#[derive(Debug, Clone, PartialEq)]
pub struct BareCommit {
    /// The `-C` directory, if the invocation gave one.
    pub dir: Option<String>,
}

/// Does this command line run a `git commit` that names no pathspec?
///
/// **The question is not academic and the answer is the whole guard.** Cards
/// standing in one working tree share one git *index* — not merely one
/// checkout — so `git add <the paths this work touched>`, which is the
/// discipline every rule in this repository asks for, stages into an index a
/// sibling has already staged into, and `git commit` with no pathspec commits
/// all of it. The window is the seconds between a sibling's `add` and its
/// `commit`, and every card in the tree is doing exactly that all day. Measured
/// on 2026-08-24: five commits in 2m14s across three cards, one of which
/// carried another card's `classify.ts`, `conversation.svelte.ts` and
/// `turns.md` under a message about something else entirely. See sink 8d3dab75.
///
/// Returns the `-C` directory when the invocation gave one, so
/// `git -C ../nova commit` is judged against the tree it will actually commit in.
///
/// **`--` is the only spelling of "has a pathspec" this accepts**, and a bare
/// trailing operand is deliberately read as absent. That is not strictness for
/// its own sake: telling apart `git commit -m fix README.md` from
/// `git commit -m fix` needs the full table of which options take a value, and
/// getting one row of that table wrong is a guard that lets the damage through.
/// The cost of the conservative reading is a call denied with a message asking
/// for the form that was already correct.
pub fn bare_commit(command: &str) -> Option<BareCommit> {
    commands(&strip_heredocs(command))
        .iter()
        .find_map(|words| commit_in(words))
}

fn commit_in(words: &[String]) -> Option<BareCommit> {
    let mut i = 0;

    /* `FOO=bar git commit`, and `env FOO=bar git commit`. An assignment is a
       word with an `=` and no separator in it; anything carrying a slash is a
       path that happens to contain one. */
    while i < words.len() {
        let w = &words[i];
        let assignment =
            !w.starts_with('-') && w.contains('=') && !w.contains('/') && !w.contains('\\');
        if w == "env" || assignment {
            i += 1;
        } else {
            break;
        }
    }

    let prog = words.get(i)?.as_str();
    let bare = prog.rsplit(['/', '\\']).next().unwrap_or(prog);
    if bare != "git" && bare != "git.exe" {
        return None;
    }
    i += 1;

    /* git's own options, which sit ahead of the subcommand. Only the ones
       taking a *separate* value have to be named; every other flag is skipped
       by shape, and the `=` forms fall out with them. */
    let mut dir = None;
    while let Some(w) = words.get(i) {
        match w.as_str() {
            "-C" => {
                dir = words.get(i + 1).cloned();
                i += 2;
            }
            "-c" | "--namespace" | "--git-dir" | "--work-tree" => i += 2,
            _ if w.starts_with('-') => i += 1,
            _ => break,
        }
    }

    if words.get(i)?.as_str() != "commit" {
        return None;
    }
    if words[i..].iter().any(|w| w == "--") {
        return None;
    }
    Some(BareCommit { dir })
}

/// The command line as a list of simple commands, each already tokenised.
///
/// Quote-aware, and that is the point rather than tidiness: a `--` inside a
/// commit message is not a pathspec, and `echo "git commit"` is not a commit.
/// Everything that separates one command from another — a semicolon, `&&`,
/// `||`, a pipe, a newline, a subshell paren — ends the current one, so a
/// `git commit` anywhere on a chained line is still found.
///
/// This is not a shell parser and does not want to be. It exists to answer one
/// yes/no question, and every way it can be wrong is arranged to end in a
/// denied call with a message naming the safe form, never in a call let through.
fn commands(line: &str) -> Vec<Vec<String>> {
    let chars: Vec<char> = line.chars().collect();
    let mut out: Vec<Vec<String>> = Vec::new();
    let mut cur: Vec<String> = Vec::new();
    let mut tok = String::new();
    let mut has = false;
    let mut quote: Option<char> = None;
    let mut i = 0;

    while i < chars.len() {
        let c = chars[i];
        if let Some(q) = quote {
            if c == q {
                quote = None;
            } else if q == '"' && c == '\\' && i + 1 < chars.len() {
                i += 1;
                tok.push(chars[i]);
            } else {
                tok.push(c);
            }
            i += 1;
            continue;
        }
        match c {
            '\'' | '"' => {
                quote = Some(c);
                has = true;
                i += 1;
            }
            '\\' if i + 1 < chars.len() => {
                i += 1;
                /* A backslash before a newline is a continuation: it joins the
                   two lines rather than contributing a character. */
                if chars[i] != '\n' {
                    tok.push(chars[i]);
                    has = true;
                }
                i += 1;
            }
            ';' | '\n' | '&' | '|' | '(' | ')' => {
                if has {
                    cur.push(std::mem::take(&mut tok));
                    has = false;
                }
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
                i += 1;
            }
            _ if c.is_whitespace() => {
                if has {
                    cur.push(std::mem::take(&mut tok));
                    has = false;
                }
                i += 1;
            }
            _ => {
                tok.push(c);
                has = true;
                i += 1;
            }
        }
    }
    if has {
        cur.push(tok);
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// Take heredoc bodies out before anything is read as a command.
///
/// **Without this the guard fires on its own commit messages.** The house style
/// writes a commit as `git commit -F -` with the message on stdin from a
/// heredoc, and the prose in this repository talks about git constantly — a
/// message containing the words "a git commit that names no pathspec" is a body
/// line that parses as exactly the thing being guarded against, while the real
/// command on the line above may well have been correct. The body is data, so
/// it is removed as data.
fn strip_heredocs(text: &str) -> String {
    let mut out = String::new();
    let mut lines = text.split('\n');
    while let Some(l) = lines.next() {
        out.push_str(l);
        out.push('\n');
        /* In order: bash reads the first delimiter's body first, so two
           heredocs opened on one line consume two runs of following lines. */
        for (delim, dash) in heredoc_delims(l) {
            for body in lines.by_ref() {
                let seen = body.trim_end_matches('\r');
                let seen = if dash { seen.trim_start_matches('\t') } else { seen };
                if seen == delim {
                    break;
                }
            }
        }
    }
    out
}

/// The heredoc delimiters opened on one line, in the order bash will read them.
///
/// The word is unquoted as bash would unquote it, since a quoted and an unquoted
/// delimiter both end at a line reading the bare word — the quoting decides
/// whether the *body* is expanded, which is nothing to do with finding its end.
/// A here-string opens no body.
fn heredoc_delims(line: &str) -> Vec<(String, bool)> {
    let c: Vec<char> = line.chars().collect();
    let mut out = Vec::new();
    let mut quote: Option<char> = None;
    let mut i = 0;

    while i < c.len() {
        if let Some(q) = quote {
            if c[i] == q {
                quote = None;
            }
            i += 1;
            continue;
        }
        match c[i] {
            '\'' | '"' => {
                quote = Some(c[i]);
                i += 1;
            }
            '\\' => i += 2,
            '<' if c.get(i + 1) == Some(&'<') => {
                i += 2;
                /* Three of them is a here-string, which has no body. */
                if c.get(i) == Some(&'<') {
                    i += 1;
                    continue;
                }
                let dash = c.get(i) == Some(&'-');
                if dash {
                    i += 1;
                }
                while c.get(i) == Some(&' ') || c.get(i) == Some(&'\t') {
                    i += 1;
                }
                let mut word = String::new();
                let mut wq: Option<char> = None;
                while let Some(&ch) = c.get(i) {
                    if let Some(q) = wq {
                        if ch == q {
                            wq = None;
                        } else {
                            word.push(ch);
                        }
                        i += 1;
                    } else if ch == '\'' || ch == '"' {
                        wq = Some(ch);
                        i += 1;
                    } else if ch == '\\' && i + 1 < c.len() {
                        word.push(c[i + 1]);
                        i += 2;
                    } else if ch.is_whitespace() || matches!(ch, ';' | '&' | '|' | ')') {
                        break;
                    } else {
                        word.push(ch);
                        i += 1;
                    }
                }
                if !word.is_empty() {
                    out.push((word, dash));
                }
            }
            _ => i += 1,
        }
    }
    out
}

/// What to say when a commit would take somebody else's work with it.
///
/// Written to the agent that is about to do it, so it names the files, names the
/// card they belong to, and ends in a command that can be run as it stands.
/// **The escape from a wrong answer is the same command as the fix**, which is
/// what makes denying safe rather than obstructive: if the guard has misjudged
/// and the files really are this card's, naming them on the commit is still the
/// right way to commit them — so there is nothing to work around, and no reason
/// for the next agent to reach for `git add -A` to get past it.
pub fn sweep_reason(root: &str, foreign: &[crate::store::Foreign]) -> String {
    let mut msg = String::from(
        "volery: this commit would take another card's work with it.\n\n\
         every card standing in one working tree shares one git *index*, not \
         merely one checkout — so `git add <your paths>` stages into an index a \
         sibling has already staged into, and a `git commit` naming no pathspec \
         commits all of it.\n\n",
    );
    msg.push_str(&format!(
        "staged in {root} right now, written by another card and not by you:\n\n"
    ));

    /* Grouped by card, because "these four files are one card's piece of work"
       is the fact that makes it obvious, and a flat list does not carry it. */
    let mut seen: Vec<&str> = Vec::new();
    for f in foreign {
        if !seen.contains(&f.conversation_id.as_str()) {
            seen.push(&f.conversation_id);
        }
    }
    for id in &seen {
        let owner = foreign.iter().find(|f| f.conversation_id == *id);
        let title = owner.map(|f| f.title.as_str()).unwrap_or("");
        let open = owner.is_some_and(|f| f.open);
        let short: String = id.chars().take(8).collect();
        let who = if title.is_empty() {
            format!("card {short}")
        } else {
            format!("{title} ({short})")
        };
        let state = if open { "still on the wall" } else { "since closed" };
        msg.push_str(&format!("  {who} — {state}\n"));
        for f in foreign.iter().filter(|f| f.conversation_id == *id) {
            msg.push_str(&format!("    {}\n", f.path));
        }
    }

    msg.push_str(
        "\nname your own paths on the commit itself:\n\n    \
         git commit -- <the files this piece of work touched>\n\n\
         that commits the working-tree content of exactly those paths and leaves \
         the rest of the index alone, so what a sibling has staged stays staged \
         and stays theirs. staging by explicit path is not enough on its own — \
         the index it stages into is the shared one.\n\n\
         if the files above are yours after all, that is still the command to use.",
    );
    msg
}

/// The impure half: is there anything to say about this command, in this tree?
///
/// `None` for every ordinary case, and for every case it cannot see clearly — no
/// repository, no database, a git that would not answer, a card working alone.
/// The guard is advisory evidence about somebody *else's* work, so an unreadable
/// answer is the same as an empty one: a card must never be unable to commit
/// because this module could not read something.
fn sweep(command: &str, cwd: Option<&str>, card: &str, db: &std::path::Path) -> Option<String> {
    let bare = bare_commit(command)?;
    let dir = match (bare.dir.as_deref(), cwd) {
        (Some(d), Some(c)) if std::path::Path::new(d).is_relative() => {
            std::path::Path::new(c).join(d)
        }
        (Some(d), _) => std::path::PathBuf::from(d),
        (None, Some(c)) => std::path::PathBuf::from(c),
        (None, None) => return None,
    };

    let root = git(&dir, &["rev-parse", "--show-toplevel"])?.trim().to_string();
    if root.is_empty() {
        return None;
    }
    let staged: Vec<String> = git(&dir, &["diff", "--cached", "--name-only", "-z"])?
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();

    let foreign = crate::store::foreign_staged(db, card, &root, &staged, crate::store::now());
    if foreign.is_empty() {
        return None;
    }
    Some(sweep_reason(&root, &foreign))
}

/// Ask git something, quietly, and never let it ask anything back.
///
/// `GIT_TERMINAL_PROMPT=0` is the house rule for anything that shells out to git
/// off its own bat — see `actions.md`. `GIT_OPTIONAL_LOCKS=0` is this module's
/// own, and matters more here than anywhere else in the app: `diff --cached`
/// will opportunistically refresh and *rewrite* the index, which means taking
/// `index.lock` — in a tree where the whole reason this code exists is that
/// several cards are running git in it at once. A guard against a shared index
/// must not become another writer to it.
fn git(dir: &std::path::Path, args: &[&str]) -> Option<String> {
    let mut cmd = std::process::Command::new("git");
    cmd.current_dir(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_CONFIG_PARAMETERS", "'credential.interactive=false'")
        .stdin(std::process::Stdio::null());
    let out = quiet(&mut cmd).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

/// No console window flashing up behind the wall. The same three lines as
/// `actions::quiet`, and deliberately not shared with it: this module is
/// reachable from `main` before anything else is set up, and a dependency from
/// here into a Tauri-shaped module is weight the hook path would pay for on
/// every shell command every card runs.
#[cfg(windows)]
fn quiet(cmd: &mut std::process::Command) -> &mut std::process::Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW)
}
#[cfg(not(windows))]
fn quiet(cmd: &mut std::process::Command) -> &mut std::process::Command {
    cmd
}

/* ── the background work a card has forgotten it started ──────────────────
 *
 * Sink fb3e537d, in the words of the agent it happened to: "I was asked whether
 * I had started the dev server on localhost:3000. I said no — every command in
 * my visible context was read-only. It was mine: my own transcript has `pnpm
 * dev` with `run_in_background: true`, three seconds before the process's start
 * time. The launch happened in an earlier stretch of the session that had been
 * summarized out of my context." It then spent three other cards' turns asking
 * who owned the process, and two of them answered confidently and wrongly.
 *
 * The shape it named is general: **a long-lived side effect outlives the
 * context that records it.** Dev servers, watchers, tunnels, `--watch` runners.
 *
 * **Volery already held the answer and had never handed it back.** The `job`
 * table (schema v17) is written on the *receipt* of a background call and the
 * row is deleted when the job reports in — so the rows outstanding at any moment
 * are, by construction rather than by a query, exactly the background work whose
 * fate nobody knows. Until now the only thing that ever read it was `rouse`,
 * telling a card what its *previous* process had lost. This tells a card what
 * its *current* process is holding, at the two moments it may have forgotten.
 *
 * ### Two occasions, and why both
 *
 * `SessionStart` with `source: "compact"` is the precise moment: the context has
 * just been rebuilt and the summary did not carry the launch. Measured firing
 * under Skein's argv — see `tools/probe-jobs.ts`, which is where every claim in
 * this section has its date.
 *
 * `UserPromptSubmit` is the backstop, and it is the one that would have caught
 * the actual incident, because that miss was an *answer to a question*. It fires
 * next to the words being answered, which is the highest-salience place
 * anything can be put. It also covers the cases the compaction hook cannot: a
 * context that was never compacted but is simply long, and a card resumed by a
 * route `rouse` did not take.
 *
 * The cost is a ~5ms process per prompt — prompts are rare against tool calls,
 * which already pay it — and roughly ninety tokens of context, only when there
 * is outstanding work at all, which is the uncommon case. When there is none
 * this prints nothing and the model sees nothing.
 *
 * ### What it must not claim
 *
 * A row says a job *started* and was never reported finished. It does not say
 * the job is running, and the difference is not pedantry: Skein only ever learns
 * a job ended by being told down the stream, so a completion notification that
 * never arrived leaves a row standing over work that finished an hour ago. So
 * the wording says **check** rather than asserting, which is the same bargain
 * `resumePrompt` strikes and for the same reason — the two states are far apart
 * and only looking distinguishes them.
 *
 * The session scope is the other half of not over-claiming, and it lives in
 * `store::outstanding_jobs`: only rows this very process wrote, so the thing
 * making the claim is the thing that made the job. */

/// Answer a `SessionStart` or a `UserPromptSubmit` with what this card is
/// holding, or with nothing at all.
///
/// `None` for every ordinary case, and there are many of them: no card id or
/// database in the argv (a hook layer built by a caller with no card to name),
/// a `SessionStart` that is not the compaction one, no session on the payload,
/// and — overwhelmingly the most common — a card with no outstanding background
/// work. Saying nothing is the whole of the quiet path.
fn standing(payload: &serde_json::Value, card: Option<&str>, db: Option<&str>) -> Option<String> {
    let (card, db) = (card?, db?);
    let event = payload.get("hook_event_name")?.as_str()?;

    /* **Only the compaction firing, and the test is here rather than in a
       matcher.** `SessionStart` also fires on `startup`, `resume` and `clear`,
       and none of those wants this: at startup there is no context to have lost,
       and a resumed card is exactly the case `rouse` already handles — it sends
       `resumePrompt` or `jobsPrompt` naming the lost jobs and then deletes the
       rows. Answering here as well would say it twice, in two different voices,
       about the same work. */
    if event == "SessionStart" {
        let source = payload.get("source").and_then(serde_json::Value::as_str);
        if source != Some("compact") {
            return None;
        }
    }

    let session = payload.get("session_id")?.as_str()?;
    let jobs = crate::store::outstanding_jobs(std::path::Path::new(db), card, session);
    let text = standing_work(&jobs, event == "SessionStart", crate::store::now())?;

    Some(
        serde_json::json!({
            "hookSpecificOutput": {
                "hookEventName": event,
                "additionalContext": text,
            }
        })
        .to_string(),
    )
}

/// The words themselves. Pure, so `cargo test` can read them.
///
/// `folded` is whether this is the compaction occasion, which is worth one
/// clause of difference: there, the loss has demonstrably just happened and
/// saying so is the difference between a reminder and an explanation. On a
/// prompt it has only *possibly* happened, and claiming otherwise would be
/// Volery asserting something it does not know.
///
/// Wrapped in a tag rather than left as loose prose because it is neither the
/// user's words nor the agent's — the same reason `blocksOf` marks a compaction
/// summary as its own kind rather than letting it read as something you typed.
pub fn standing_work(jobs: &[crate::store::PendingJob], folded: bool, now: i64) -> Option<String> {
    if jobs.is_empty() {
        return None;
    }

    let mut s = String::from("<volery-background-work>\n");
    s.push_str(if folded {
        "Your context has just been summarised. This card started background work that has \
         not reported in, and the summary above does not carry it — Volery's record outlives \
         your context, which is the whole reason this is here.\n\n"
    } else {
        "This card started background work that has not reported in. It may have been \
         launched in a stretch of this session that was summarised away, in which case this \
         is the only account of it you have.\n\n"
    });

    for (i, j) in jobs.iter().enumerate() {
        s.push_str(&format!(
            "  {}. {} — {}, started {} ago",
            i + 1,
            j.label,
            j.kind,
            ago(now - j.started_at),
        ));
        if let Some(t) = &j.task_id {
            s.push_str(&format!(", task {t}"));
        }
        s.push('\n');
        /* The path is only ever here if a file is really at it —
           `store::pending_jobs` existence-checks a derived one. Sending an agent
           to read something that is not there reads as the work having vanished
           rather than as Volery having guessed. */
        if let Some(p) = &j.output_path {
            s.push_str(&format!("     output: {p}\n"));
        }
    }

    s.push_str(
        "\nCheck before telling anyone whether it is still running — read the output file, or \
         use the task id. A job that finished without its completion notification arriving is \
         still listed here; the row is deleted when that notification lands, and the case this \
         exists for is the one where it never came.\n</volery-background-work>",
    );
    Some(s)
}

/// How long ago, in the wall's own register: two units at most, and never a
/// decimal.
///
/// Milliseconds in, because `store::now()` is — getting that wrong would report
/// a four-hour dev server as having started four seconds ago, which is precisely
/// the reading that would make an agent dismiss it.
fn ago(ms: i64) -> String {
    let s = (ms / 1000).max(0);
    if s < 60 {
        return format!("{s}s");
    }
    let (m, h, d) = (s / 60, s / 3600, s / 86_400);
    if m < 60 {
        return format!("{m}m");
    }
    if h < 24 {
        let rest = m % 60;
        return if rest == 0 { format!("{h}h") } else { format!("{h}h {rest}m") };
    }
    let rest = h % 24;
    if rest == 0 {
        format!("{d}d")
    } else {
        format!("{d}d {rest}h")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What the Bash tool was measured to do, so the test can assert a
    /// round-trip rather than a hard-coded expectation of `compensate`.
    /// `ceil(n/2)` per run, except a run against a `"`, which is left whole.
    fn collapse(s: &str) -> String {
        let bytes = s.as_bytes();
        let mut out: Vec<u8> = Vec::new();
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] != b'\\' {
                out.push(bytes[i]);
                i += 1;
                continue;
            }
            let start = i;
            while i < bytes.len() && bytes[i] == b'\\' {
                i += 1;
            }
            let n = i - start;
            let keep = if bytes.get(i) == Some(&b'"') {
                n
            } else {
                n.div_ceil(2)
            };
            out.extend(std::iter::repeat_n(b'\\', keep));
        }
        String::from_utf8(out).unwrap()
    }

    /// The runs measured directly out of a heredoc, as a table so a regression
    /// names the length that broke.
    #[test]
    fn collapse_model_matches_what_was_measured() {
        for (emitted, arrived) in [(1, 1), (2, 1), (3, 2), (4, 2), (5, 3), (6, 3)] {
            let s = "\\".repeat(emitted);
            assert_eq!(
                collapse(&format!("x={s}")),
                format!("x={}", "\\".repeat(arrived)),
                "a run of {emitted} should arrive as {arrived}"
            );
        }
    }

    /// The exception, at every length it was measured at.
    #[test]
    fn a_run_against_a_quote_survives_whole() {
        for n in 1..=4 {
            let s = format!("{}\"", "\\".repeat(n));
            assert_eq!(collapse(&s), s, "a run of {n} before a quote must survive");
            assert_eq!(compensate(&s), s, "and must therefore not be doubled");
        }
    }

    #[test]
    fn a_single_quote_does_not_protect() {
        assert_eq!(collapse("a\\\\'"), "a\\'");
    }

    #[test]
    fn compensation_round_trips() {
        let cases = [
            // the real failures, out of the transcripts that found this
            r#"const db = new Database(process.env.APPDATA + "\\dev.skein.studio\\skein.db");"#,
            r#"awk '{ n=gsub(/\\/,"\\"); print n }' f"#,
            // ordinary shell backslashes, which must come out unchanged
            r"grep -n 'foo\.ts$' file",
            r"find . -name '*.ts' -exec grep -l x {} \;",
            r#"printf "%s\n" hi"#,
            r"echo 'C:\\Users\\flori' > /tmp/p",
            r"sed -i 's/a/b/' x && echo done",
            // nothing to do at all
            "git status --porcelain",
            "",
        ];

        for c in cases {
            assert_eq!(
                collapse(&compensate(c)),
                c,
                "should arrive exactly as written: {c:?}"
            );
        }
    }

    /// The bug is real: without compensation most of those are corrupted. If
    /// this ever fails, the Bash tool has been fixed and this module should go.
    #[test]
    fn the_cases_are_actually_broken_without_it() {
        let broken = [
            r#"const db = new Database(process.env.APPDATA + "\\dev.skein.studio\\skein.db");"#,
            r"echo 'C:\\Users\\flori' > /tmp/p",
        ];
        for c in broken {
            assert_ne!(collapse(c), c, "expected {c:?} to be corrupted uncompensated");
        }
    }

    #[test]
    fn utf8_survives_the_byte_scan() {
        let s = "echo 'caf\u{e9} \u{2014} \u{1f600}' && ls C:\\\\tmp";
        let out = compensate(s);
        assert!(out.contains('\u{2014}') && out.contains('\u{1f600}'));
        assert_eq!(collapse(&out), s);
    }

    #[test]
    fn rewrite_preserves_the_rest_of_the_input() {
        let raw = r#"{"tool_name":"Bash","tool_input":{"command":"echo 'a\\b'","description":"keep","timeout":5}}"#;
        let out = reply(raw, None, None).expect("a command with backslashes should be rewritten");
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        let upd = &v["hookSpecificOutput"]["updatedInput"];
        assert_eq!(upd["description"], "keep");
        assert_eq!(upd["timeout"], 5);
        assert_eq!(v["hookSpecificOutput"]["hookEventName"], "PreToolUse");
        assert_eq!(collapse(upd["command"].as_str().unwrap()), r"echo 'a\b'");
    }

    /// Every one of these leaves the command alone, which is the whole of the
    /// fail-open promise.
    #[test]
    fn nothing_is_said_when_there_is_nothing_to_say() {
        for raw in [
            "",
            "not json",
            "{}",
            r#"{"tool_input":null}"#,
            r#"{"tool_input":{}}"#,
            r#"{"tool_input":{"command":42}}"#,
            // no backslash anywhere
            r#"{"tool_input":{"command":"git status"}}"#,
            // a lone run against a quote needs no change
            r#"{"tool_input":{"command":"echo \"a\\\\\"\""}}"#,
        ] {
            assert!(reply(raw, None, None).is_none(), "should have declined: {raw:?}");
        }
    }

    #[test]
    fn settings_carry_the_hook_in_exec_form() {
        let v: serde_json::Value = serde_json::from_str(&settings(false, None)).unwrap();
        let h = &v["hooks"]["PreToolUse"][0];
        /* No matcher: the Windows shell tool was renamed once already and a
           matcher that stops matching says nothing when it does. See the
           module note. */
        assert!(h.get("matcher").is_none(), "a matcher is a name that can rot");
        assert_eq!(h["hooks"][0]["type"], "command");
        assert_eq!(h["hooks"][0]["args"][0], FLAG);
        assert_eq!(h["hooks"][0]["args"].as_array().unwrap().len(), 1);
        assert!(v.get("permissions").is_none(), "a project card gets no allow list");

        let chat: serde_json::Value = serde_json::from_str(&settings(true, None)).unwrap();
        assert_eq!(chat["permissions"]["allow"][0], "WebSearch");
        assert_eq!(chat["hooks"]["PreToolUse"][0]["hooks"][0]["type"], "command");
    }

    /// The two occasions a card is handed back the background work it may have
    /// forgotten. Registered against the same binary with the same argv, and —
    /// like `PreToolUse` — with no matcher, so nothing can quietly stop matching.
    #[test]
    fn the_two_forgetting_hooks_are_registered_the_same_way() {
        let v: serde_json::Value = serde_json::from_str(&settings(false, None)).unwrap();
        for ev in ["SessionStart", "UserPromptSubmit"] {
            let h = &v["hooks"][ev][0];
            assert!(h.get("matcher").is_none(), "{ev}: a matcher is a name that can rot");
            assert_eq!(h["hooks"][0]["type"], "command", "{ev}");
            assert_eq!(h["hooks"][0]["args"][0], FLAG, "{ev}");
        }
        /* A chat card gets them too. It can run nothing, so it will never have a
           row — but the registration must not be the thing that decides that,
           or the day a chat card gains a tool the guard is silently absent. */
        let chat: serde_json::Value = serde_json::from_str(&settings(true, None)).unwrap();
        assert!(chat["hooks"]["UserPromptSubmit"][0]["hooks"][0]["args"][0] == FLAG);
    }

    fn job(label: &str, kind: &str, task: Option<&str>, path: Option<&str>, at: i64) -> crate::store::PendingJob {
        crate::store::PendingJob {
            tool_id: format!("toolu_{label}"),
            task_id: task.map(str::to_string),
            kind: kind.to_string(),
            label: label.to_string(),
            output_path: path.map(str::to_string),
            started_at: at,
        }
    }

    /// The quiet path, and it is the overwhelmingly common one: a card with no
    /// outstanding background work is handed nothing at all, so the model sees
    /// nothing and the prompt costs no context.
    #[test]
    fn a_card_holding_nothing_is_told_nothing() {
        assert!(standing_work(&[], false, 1_000_000).is_none());
        assert!(standing_work(&[], true, 1_000_000).is_none());
    }

    /// Everything the agent in sink fb3e537d needed and did not have: that it
    /// started the thing, how long ago, and where to look.
    #[test]
    fn the_forgotten_dev_server_is_named_with_somewhere_to_look() {
        let now = 100_000_000;
        let four_hours = now - (4 * 3600 + 12 * 60) * 1000;
        let out = standing_work(
            &[job("run the dev server", "command", Some("btuqox9zy"), Some(r"C:\t\btuqox9zy.output"), four_hours)],
            false,
            now,
        )
        .unwrap();

        assert!(out.contains("run the dev server"));
        assert!(out.contains("4h 12m ago"), "the age is the whole point of the row: {out}");
        assert!(out.contains("btuqox9zy"), "the task id is what BashOutput takes");
        assert!(out.contains(r"C:\t\btuqox9zy.output"));
        /* Wrapped, because these are neither the user's words nor the agent's. */
        assert!(out.starts_with("<volery-background-work>"));
        assert!(out.ends_with("</volery-background-work>"));
    }

    /// **It must not claim the work is running**, and this is the assertion that
    /// keeps it honest. A row says a job started and was never reported
    /// finished; Skein only ever learns a job ended by being told down the
    /// stream, so a notification that never arrived leaves a row standing over
    /// work that finished an hour ago. Same bargain `resumePrompt` strikes.
    #[test]
    fn it_says_check_rather_than_asserting() {
        let out = standing_work(&[job("a suite", "command", None, None, 0)], false, 60_000).unwrap();
        assert!(out.contains("Check before"), "{out}");
        assert!(
            out.contains("finished without its completion notification"),
            "the stale-row case has to be said out loud, or the list reads as a fact: {out}"
        );
        assert!(!out.contains("is running"), "no assertion about the present: {out}");
    }

    /// The compaction occasion says the loss has just happened, because there it
    /// demonstrably has. On a prompt it has only *possibly* happened, and
    /// claiming otherwise would be Volery asserting what it does not know.
    #[test]
    fn the_two_occasions_differ_by_what_can_be_claimed() {
        let j = [job("a watcher", "watch", None, None, 0)];
        let folded = standing_work(&j, true, 60_000).unwrap();
        let prompt = standing_work(&j, false, 60_000).unwrap();
        assert!(folded.contains("has just been summarised"), "{folded}");
        assert!(prompt.contains("may have been"), "{prompt}");
        assert!(!prompt.contains("has just been summarised"));
    }

    /// A job with no output file — a `Monitor` or an `Agent` whose derived path
    /// was not there — is still worth naming. Knowing work was started is the
    /// point; where to read it is a bonus, and inventing a path would send an
    /// agent to find nothing, which reads as the work having vanished.
    #[test]
    fn a_job_with_nowhere_to_look_is_still_named() {
        let out = standing_work(&[job("a subagent", "agent", None, None, 0)], false, 60_000).unwrap();
        assert!(out.contains("a subagent"));
        assert!(!out.contains("output:"), "no path invented: {out}");
    }

    #[test]
    fn several_jobs_are_numbered() {
        let out = standing_work(
            &[job("one", "command", None, None, 0), job("two", "command", None, None, 0)],
            false,
            60_000,
        )
        .unwrap();
        assert!(out.contains("1. one"));
        assert!(out.contains("2. two"));
    }

    /// Milliseconds in. Reporting a four-hour dev server as four seconds old is
    /// exactly the reading that would make an agent dismiss it.
    #[test]
    fn ages_read_in_the_walls_own_register() {
        assert_eq!(ago(0), "0s");
        assert_eq!(ago(45_000), "45s");
        assert_eq!(ago(90_000), "1m");
        assert_eq!(ago(3_600_000), "1h");
        assert_eq!(ago((4 * 3600 + 12 * 60) * 1000), "4h 12m");
        assert_eq!(ago(86_400_000), "1d");
        assert_eq!(ago(90_000_000), "1d 1h");
        /* A clock that stepped backwards must not print a negative age. */
        assert_eq!(ago(-5_000), "0s");
    }

    /// `SessionStart` fires on `startup`, `resume` and `clear` as well, and none
    /// of those wants this. A resumed card is `rouse`'s case — it already sends
    /// a prompt naming the lost jobs and then deletes the rows — so answering
    /// here too would say it twice about the same work, in two voices.
    #[test]
    fn only_the_compaction_firing_of_session_start_answers() {
        let at = |source: &str| {
            format!(r#"{{"hook_event_name":"SessionStart","source":"{source}","session_id":"s1"}}"#)
        };
        for quiet in ["startup", "resume", "clear"] {
            assert!(
                reply(&at(quiet), Some("card"), Some("nowhere.db")).is_none(),
                "{quiet} must say nothing"
            );
        }
        /* `compact` gets as far as the database, which is not there — so still
           None, and silently, which is the fail-open this whole module keeps. */
        assert!(reply(&at("compact"), Some("card"), Some("nowhere.db")).is_none());
    }

    /// A hook layer with no card named leaves these two doing nothing, the way
    /// it leaves the index guard doing nothing — there is no card whose jobs
    /// these would be.
    #[test]
    fn the_forgetting_hooks_need_a_card_to_be_about() {
        let p = r#"{"hook_event_name":"UserPromptSubmit","prompt":"hi","session_id":"s1"}"#;
        assert!(reply(p, None, None).is_none());
    }

    /// **The routing must not eat the old path.** A payload from a build that
    /// sends no `hook_event_name` falls through to the `PreToolUse` body, which
    /// was the whole discriminator before this arm existed.
    #[test]
    fn a_payload_with_no_event_name_still_reaches_the_compensator() {
        let cmd = r#"{"tool_name":"Bash","tool_input":{"command":"echo 'a\\b'"}}"#;
        assert!(reply(cmd, None, None).is_some());
        /* And one that names PreToolUse explicitly reaches it too. */
        let named = r#"{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"echo 'a\\b'"}}"#;
        assert!(reply(named, None, None).is_some());
    }

    /// Now that the hook fires on every tool, the tool name is what decides
    /// whether a command is compensated — and getting this wrong is worse than
    /// not compensating at all, since it *adds* backslashes to a shell that
    /// never lost any. Probed 2026-08-25: the PowerShell tool has no collapse.
    #[test]
    fn only_the_bash_tool_is_compensated() {
        let cmd = r#"{"tool_name":"%NAME%","tool_input":{"command":"echo 'a\\b'"}}"#;
        assert!(
            reply(&cmd.replace("%NAME%", "Bash"), None, None).is_some(),
            "the Bash tool eats backslashes and must be compensated"
        );
        for other in ["PowerShell", "Read", "Edit", ""] {
            assert!(
                reply(&cmd.replace("%NAME%", other), None, None).is_none(),
                "{other} must be left alone"
            );
        }
    }

    /// And a tool with no `command` at all is not a shell call, whatever it is
    /// named — which is how a `Read` leaves now that there is no matcher.
    #[test]
    fn a_tool_with_no_command_is_not_a_shell_call() {
        assert!(reply(r#"{"tool_name":"Read","tool_input":{"file_path":"a.ts"}}"#, None, None).is_none());
    }

    /// A named card puts its id and its database in the argv, so a hook process
    /// needs neither the payload's session id nor the `dev.skein.studio` string.
    #[test]
    fn a_named_card_arms_the_guard_through_the_argv() {
        let dir = std::path::Path::new("C:/Users/x/AppData/Roaming/dev.skein.studio");
        let v: serde_json::Value =
            serde_json::from_str(&settings(false, Some(("abc123", dir)))).unwrap();
        let args = v["hooks"]["PreToolUse"][0]["hooks"][0]["args"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a.as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        assert_eq!(args[0], FLAG);
        assert_eq!(after(&args, FLAG_CARD), Some("abc123"));
        assert!(after(&args, FLAG_DB).unwrap().ends_with("skein.db"));
    }

    /* ── the shared index ─────────────────────────────────────────────────── */

    /// The forms that arrive with nothing naming what they commit. Every one of
    /// these is a call that would take a sibling's staged work with it.
    #[test]
    fn a_commit_with_no_pathspec_is_seen() {
        for command in [
            "git commit -m 'fix the thing'",
            "git add src/lib/a.ts && git commit -F -",
            "cd repo; git commit --amend --no-edit",
            "git add -A && git commit -m x && git push",
            "FOO=bar git commit -m x",
            "env GIT_EDITOR=true git commit",
            "/usr/bin/git commit -m x",
            "git -c user.name=x commit -m y",
            "git commit -a -m x",
            "echo hi | git commit -F -",
        ] {
            assert!(
                bare_commit(command).is_some(),
                "should have been seen as bare: {command:?}"
            );
        }
    }

    /// And the forms that name their paths, which are the ones that are safe in
    /// a shared tree and the ones the guard is asking for.
    #[test]
    fn a_commit_that_names_its_paths_is_left_alone() {
        for command in [
            "git commit -- src/lib/a.ts",
            "git add src/lib/a.ts && git commit -F - -- src/lib/a.ts",
            "git commit -m x -- a.ts b.ts",
            "git -C ../nova commit -m x -- a.ts",
        ] {
            assert!(
                bare_commit(command).is_none(),
                "should have been left alone: {command:?}"
            );
        }
    }

    /// Nothing that is not a commit at all.
    #[test]
    fn only_a_commit_is_a_commit() {
        for command in [
            "git status",
            "git add -A",
            "git log --oneline -3",
            "echo 'git commit -m x'",
            "grep -rn 'git commit' .claude/",
            "gitk commit",
            "mygit commit -m x",
        ] {
            assert!(
                bare_commit(command).is_none(),
                "should not be a commit: {command:?}"
            );
        }
    }

    /// `-C` decides which tree is judged, since that is the tree the commit
    /// will land in.
    #[test]
    fn the_dash_c_directory_comes_back() {
        assert_eq!(
            bare_commit("git -C ../nova commit -m x").unwrap().dir.as_deref(),
            Some("../nova")
        );
        assert_eq!(bare_commit("git commit -m x").unwrap().dir, None);
    }

    /// The failure this repository would hit on its very next commit: the house
    /// style writes the message into a heredoc, and the prose in it talks about
    /// git. The body is data and must not be read as a command.
    #[test]
    fn a_commit_message_is_not_a_command() {
        let command = "git add a.rs && git commit -F - -- a.rs <<'EOF'\n\
                       skein: guard the shared index\n\n\
                       a `git commit` naming no pathspec commits the whole index,\n\
                       so `git add <paths>` is not enough on its own.\n\
                       EOF";
        assert!(
            bare_commit(command).is_none(),
            "the heredoc body was read as a command"
        );
    }

    /// And the other way round: a heredoc body does not hide a bare commit on
    /// the line that opened it.
    #[test]
    fn the_line_that_opens_a_heredoc_is_still_read() {
        let command = "git commit -F - <<'EOF'\nsome message\nEOF";
        assert!(bare_commit(command).is_some());
    }

    #[test]
    fn heredoc_bodies_are_taken_out() {
        let text = "cmd <<'A'\nbody A\nA\nafter\n";
        assert_eq!(strip_heredocs(text), "cmd <<'A'\nafter\n\n");

        /* Two on one line, read in the order bash reads them. */
        let two = "cmd <<A <<B\nfirst\nA\nsecond\nB\ntail\n";
        assert_eq!(strip_heredocs(two), "cmd <<A <<B\ntail\n\n");

        /* A here-string opens no body. */
        assert_eq!(strip_heredocs("cmd <<<word\nnext\n"), "cmd <<<word\nnext\n\n");

        /* `<<-` strips leading tabs from the closing delimiter. */
        assert_eq!(strip_heredocs("cmd <<-E\n\tbody\n\tE\nnext\n"), "cmd <<-E\nnext\n\n");
    }

    /// A `--` inside a quoted message is not a pathspec, and a `git commit`
    /// inside a quoted string is not a commit. Both are the tokeniser's job.
    #[test]
    fn quotes_are_respected() {
        assert!(bare_commit("git commit -m 'fix -- the thing'").is_some());
        assert!(bare_commit(r#"git commit -m "a -- b""#).is_some());
        assert!(bare_commit("echo \"git commit -m x\"").is_none());
    }

    /// What the agent is handed. It has to name the files, name whose they are,
    /// and end in a command that can be run as it stands — including when the
    /// guard is wrong, which is what makes denying safe.
    #[test]
    fn the_reason_names_the_files_the_card_and_the_way_out() {
        let foreign = vec![
            crate::store::Foreign {
                path: "src/lib/classify.ts".into(),
                conversation_id: "4490db57aaaa".into(),
                title: "working the sink".into(),
                open: true,
            },
            crate::store::Foreign {
                path: "test/classify.test.ts".into(),
                conversation_id: "4490db57aaaa".into(),
                title: "working the sink".into(),
                open: true,
            },
        ];
        let msg = sweep_reason("C:/Users/x/workbench/skein", &foreign);
        assert!(msg.contains("src/lib/classify.ts"));
        assert!(msg.contains("test/classify.test.ts"));
        assert!(msg.contains("working the sink (4490db57)"));
        assert!(msg.contains("still on the wall"));
        assert!(msg.contains("git commit -- "));
        /* The two files are one card's piece of work and are drawn as one. */
        assert_eq!(msg.matches("working the sink").count(), 1);
    }
}
