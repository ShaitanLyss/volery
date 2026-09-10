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

    /* The second thing this binary is, and it is here rather than in `main` for
       the reason the hook is: it must not open a window or join the wall.
       `--secret <service> --card <id> --db <path>` prints a credential to stdout
       and exits, and prints **nothing** unless the wall's own database says that
       card was granted it.
       See `docket.rs` for what a grant is and `serve_secret` just below for why
       this exists at all rather than the token simply being in the environment. */
    if args.iter().any(|a| a == FLAG_SECRET) {
        if let Some(out) = serve_secret(
            after(&args, FLAG_SECRET),
            after(&args, FLAG_CARD),
            after(&args, FLAG_DB),
        ) {
            print!("{out}");
        }
        return true;
    }

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

/// Print a granted credential, or print nothing.
///
/// **This exists because an environment can only be set when a process starts.**
/// `spawn_now` puts a granted token in the card's environment, which is where a
/// script should find one — but the turn that *asks* for the grant is running in
/// a process that was spawned before the user agreed, and there is no supported
/// way to change its environment from outside. Without this, a card would be
/// told "granted, now end your turn and come back", which is a feature nobody
/// would use at the moment they needed it.
///
/// So the answer to that turn is a command it can run:
///
/// ```text
/// export ASANA_ACCESS_TOKEN=$(volery --secret asana --card <id> --db <path>)
/// ```
///
/// and from the next spawn onward the variable is simply there.
///
/// **Every failure prints nothing**, which is the direction that matters: an
/// unreadable database, a missing card, a service nobody has heard of and a
/// card with no grant all produce empty output and exit 0. A version that
/// printed a diagnostic would put it where a shell is about to assign it to a
/// variable, and a version that printed the token when it could not check would
/// hand out a credential on the strength of an error.
///
/// No newline, for the same reason: this is written to be captured by `$(…)`,
/// and while command substitution strips trailing newlines, Python's
/// `subprocess` and PowerShell's `$()` do not always. A bearer token with a
/// stray `\n` in it fails with a 401 that names nothing.
///
/// The database is opened **read-only** through `store::open_readonly`, which is
/// the same rule `sweep` follows and for the same reason: a short-lived process
/// that ran the migration ladder would be a second writer racing the wall.
fn serve_secret(service: Option<&str>, card: Option<&str>, db: Option<&str>) -> Option<String> {
    let (service, card, db) = (service?, card?, db?);
    /* Asked of the same registry the panel and `asana.rs` use, so an id nothing
       answers for is refused by name rather than reaching the vault — the
       property `creds.rs` chose a service vocabulary for. */
    let conn = crate::store::open_readonly(std::path::Path::new(db))?;
    if !crate::store::secret_granted(&conn, card, service) {
        return None;
    }
    crate::creds::token(service)
}

/// The value given after a flag, if it was given at all.
fn after<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    let at = args.iter().position(|a| a == flag)?;
    args.get(at + 1).map(String::as_str).filter(|v| !v.is_empty())
}

/// A refusal, in the shape the CLI reads one.
///
/// Written once because there are two guards now and there will be a third:
/// the wrapper is four keys nobody should be retyping, and this module's own
/// history is what a second copy of a fact costs (`hooks.md`, the matcher that
/// stopped matching). Probed against 2.1.241: `permissionDecision: "deny"` does
/// stop a tool call on a card spawned with `--dangerously-skip-permissions`,
/// and the reason string reaches the model.
fn deny(reason: String) -> String {
    serde_json::json!({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    })
    .to_string()
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
        let db = std::path::Path::new(db);
        /* Two guards, and no command can trip both — one is a commit and the
           other never is — so the order is a statement about what is at stake
           rather than a precedence. A swept commit is recoverable: the code is
           intact and only the message is wrong. A cleaned tree is not. */
        if let Some(reason) = perilous(command, cwd, card, db) {
            return Some(deny(reason));
        }
        if let Some(reason) = sweep(command, cwd, card, db) {
            return Some(deny(reason));
        }
    }

    /* The third, and it needs neither the card nor the database -- it is a
       judgement about the command line and nothing else, so it holds on a spawn
       that named no card, where the two above step aside. Last of the three
       because it is the cheapest to be wrong about: a swept commit loses a
       message, a cleaned tree loses work, and this one loses a rename. */
    if let Some(d) = displaced(command) {
        return Some(deny(displaced_reason(&d)));
    }

    /* The fourth, and the one with the widest reach. Last because it is the
       most likely to be reached for legitimately and the reason it hands back
       is the longest -- and because `displaced` above must get first refusal on
       a `mv`, which this one does not match anyway but which reads better
       stated than relied on. */
    if let Some(w) = wipes(command) {
        return Some(deny(wipe_reason(&w)));
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
pub fn settings(chat: bool, card: Option<(&str, &std::path::Path)>, locked: bool) -> String {
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

    /* The read-only lock, and it is the whole enforcement — three tool names in
       an array (sink `8dde1cc1`).

       **It bites through `--dangerously-skip-permissions`, and that was worth a
       real turn to prove rather than assume.** Every project card carries the
       bypass flag, so a deny that the flag overrode would be a switch that is on
       and does nothing — the worst available shape, since the settings JSON
       would be exactly as written and no error would appear anywhere.
       `tools/probe-lock.ts` spawns two turns with Skein's own argv and the deny
       array as the only variable: with it, the file is not written.

       **And it holds by withholding rather than by refusing**, which is the part
       the bundle's own wording does not tell you: measured 2026-09-05 against
       2.1.233, a denied tool is *not in the card's tool list at all*. It is not
       offered and then refused. That is the better half of the bargain — no
       denied call to pay for, and the card plans around the absence rather than
       discovering it mid-turn — with one cost that has to be paid elsewhere:
       nothing tells the card *why*. "Not in my tool list" is indistinguishable
       from a CLI that never had the tool, so the card went looking through
       `ToolSearch` first and could not have told the user the territory was
       locked. `guidance::compose` says so in the system prompt for exactly that
       reason, and the two halves are one feature.

       **Three names, and the shell is deliberately not among them.** A card with
       no `git log`, no `rg` and no `bun test` is not a read-only card, it is a
       broken one, so denying the shell wholesale is out; and a blocklist of
       writing shell verbs is leaky by construction and can refuse legitimate
       work, which is a promise about what the switch means rather than an
       implementation detail. Asked, and held for a decision — sink `b3230b03`
       carries the question. Until it is answered the switch says what it does
       and no more, which is why the panel's label names the tools.

       Set beside a chat card's `allow` rather than merged with it, because the
       two cases cannot both apply: a chat card has no file tool to deny. */
    if locked {
        root.insert(
            "permissions".into(),
            serde_json::json!({ "deny": ["Edit", "Write", "NotebookEdit"] }),
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

/// What this binary is asked by, to hand a card a credential it was granted.
///
/// Not in the settings layer and never spawned by us — the *card* runs this, in
/// its own shell, on the one turn where the environment cannot yet carry the
/// answer. See `serve_secret`.
pub const FLAG_SECRET: &str = "--secret";

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
///
/// ### What this guard does not catch, and cannot be widened to catch cheaply
///
/// **`git commit -- <path>` is exempt, and that exemption is only correct about
/// the index.** It commits *the working-tree content of that path*, including
/// edits a sibling made to it in the seconds before — so naming the path
/// protects you from the shared index and not at all from another card being
/// inside the same file. Measured 2026-08-27 during a nine-card split: one card
/// wrote a ~100-line section into `.claude/rules/hooks.md`, another committed
/// that file seconds later with explicit paths exactly as every rule here
/// instructs, and took the section with it. It is in `25c5fc8`, whose message is
/// about the job drawer's Rust half and describes none of it. Nothing was lost
/// and only the message is wrong, which is why it is cheap *this* time. Sink
/// aa14a0b7.
///
/// **Left alone deliberately, and this is the judgement rather than an
/// oversight.** The only thing a `PreToolUse` hook can do about a command on
/// this machine is `deny` it — probed against 2.1.241 — and every rule in this
/// repository and every notice on the board tells cards to name their paths. A
/// guard that denies the form it also instructs is a guard that has to be
/// right every time, and its false positives land on the one command a card was
/// told to use. Adding a *warning* is what this wants and there is no probed way
/// to emit one: whether `permissionDecision: "allow"` carries its
/// `permissionDecisionReason` to the model is unmeasured, and `PostToolUse` is
/// not registered in `settings` at all.
///
/// So the trap is written down here and in `hooks.md`, and the two implementable
/// designs plus the missing probe are in the sink rather than half-built. What
/// makes that defensible is the shape of the damage: a swept explicit-path commit
/// loses nothing — the code is intact, both cards' work is committed, and only
/// the message is wrong — where a guard that blocks the instructed form stops
/// work.
pub fn bare_commit(command: &str) -> Option<BareCommit> {
    commands(&strip_heredocs(command))
        .iter()
        .find_map(|words| commit_in(words))
}

/// Where the subcommand is in a git invocation, and what `-C` said.
///
/// Walks past environment assignments, the `git` itself, and git's own options.
/// Shared by `commit_in` and `tree_wide_in` rather than written out twice —
/// this module has already paid once for a fact written down in two places
/// (`hooks.md`, the matcher that stopped matching), and two copies of "what
/// counts as a git invocation" is the same bet.
///
/// `None` for anything that is not git at all.
fn git_at(words: &[String]) -> Option<(usize, Option<String>)> {
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

    Some((i, dir))
}

fn commit_in(words: &[String]) -> Option<BareCommit> {
    let (i, dir) = git_at(words)?;
    if words.get(i)?.as_str() != "commit" {
        return None;
    }
    /* A pathspec, so this is not the commit `sweep` is about. Correct about the
       *index* and not about the working tree — see the section at the end of
       `bare_commit`'s doc, and sink aa14a0b7. Do not widen this to catch that
       case without reading it: the widening is a deny on the form every rule
       here asks for. */
    if words[i..].iter().any(|w| w == "--") {
        return None;
    }
    Some(BareCommit { dir })
}

/// A git invocation that reaches the whole working tree rather than the paths
/// it names.
#[derive(Debug, Clone, PartialEq)]
pub struct TreeWide {
    /// The subcommand as it was typed, which is what the refusal names back.
    pub verb: String,
    /// The `-C` directory, if the invocation gave one.
    pub dir: Option<String>,
}

/// Does this command line run a git that throws work away across the whole tree?
///
/// **The index guard is not this guard, and the gap between them is the whole
/// reason this exists.** `bare_commit`/`sweep` catch a *commit* that would
/// sweep a sibling's **staged** work. `git stash` is not a commit and never
/// reaches them: it takes every card's uncommitted work out of the checkout in
/// one stroke, silently, and — since a stash without `-u` carries no untracked
/// files — a `git clean` beside it is not recoverable at all. Measured
/// 2026-08-27: one card ran `git stash` in a tree nine cards shared, wiping
/// nine files across four of them, found only because a card happened to read
/// back a file it had just written and saw its own changes gone. Sink 7f6bfe2f.
///
/// **`--` is the only spelling of "has a pathspec" this accepts**, exactly as
/// `bare_commit` argues two functions up and for the same reason: telling
/// `git restore -s HEAD file` from `git restore file` needs the full table of
/// which options take a value, and one wrong row is a guard that lets the
/// damage through. The cost of the conservative reading is a call denied with a
/// message naming the form that was already correct.
///
/// **Deliberately absent: `rebase`, `merge`, `pull`, `switch`.** Git refuses
/// every one of them against a dirty tree of its own accord, so none of them
/// silently destroys uncommitted work, and denying them would stop legitimate
/// work to no end. What is here is the set whose whole purpose is to discard.
pub fn tree_wide(command: &str) -> Option<TreeWide> {
    commands(&strip_heredocs(command))
        .iter()
        .find_map(|words| tree_wide_in(words))
}

fn tree_wide_in(words: &[String]) -> Option<TreeWide> {
    let (i, dir) = git_at(words)?;
    let verb = words.get(i)?.as_str();
    let rest = &words[i + 1..];

    let discards = match verb {
        /* `clean` only ever deletes untracked files, and those are exactly what
           a stash does not carry — so there is nothing to recover them from and
           no form of it is safe in a tree somebody else is working in. */
        "clean" => true,
        /* Everything but reading it. `pop` and `apply` write work back into a
           tree that has moved on since; `drop` and `clear` destroy the only
           copy of whatever a previous stash took; a bare `stash` or an explicit
           `push` takes everybody's at once. `list` and `show` only read. */
        "stash" => !matches!(operand(rest), Some("list") | Some("show")),
        /* The pathspec forms are the recovery procedure and have to stay
           reachable: `git checkout <ref> -- <one file>` is what puts a wiped
           file back, and a guard that denied it would be denying the way out —
           which is the property `sweep_reason` argues makes a refusal safe. */
        "reset" | "checkout" | "restore" => !names_a_path(rest),
        _ => false,
    };

    discards.then(|| TreeWide {
        verb: verb.to_string(),
        dir,
    })
}

/// The first word that is not a flag.
fn operand(words: &[String]) -> Option<&str> {
    words
        .iter()
        .find(|w| !w.starts_with('-'))
        .map(String::as_str)
}

/// Is there a `--` with at least one real path after it?
///
/// `.`, `./` and `:/` are not real paths for this purpose — each names the
/// whole tree, so `git checkout -- .` is the thing being guarded against
/// wearing the shape of the thing that is allowed.
fn names_a_path(words: &[String]) -> bool {
    let Some(at) = words.iter().position(|w| w == "--") else {
        return false;
    };
    words[at + 1..]
        .iter()
        .any(|w| !w.is_empty() && w != "." && w != "./" && w != ":/")
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

/// What to say when a command would throw away work this card did not write.
///
/// Same contract as `sweep_reason` and for the same reason: **the escape from a
/// wrong answer is the same command as the fix.** If the guard has misjudged
/// and there really is nobody else's work in this tree, naming the paths is
/// still the right way to do what was wanted — so there is nothing to work
/// around, and no reason for the next agent to go looking for a spelling that
/// gets past it. Every alternative below is a command that can be run as it
/// stands.
///
/// It names the siblings, because "four other cards are standing in this tree"
/// is the fact that makes the refusal obvious rather than officious.
pub fn perilous_reason(tw: &TreeWide, siblings: &[crate::store::Sibling]) -> String {
    let verb = &tw.verb;
    let mut msg =
        format!("volery: `git {verb}` reaches the whole working tree, and you are not alone in it.\n\n");

    msg.push_str(match verb.as_str() {
        "clean" => {
            "it deletes untracked files, which are the one thing `git stash` does not keep — \
             so there would be nothing anywhere to recover them from.\n\n"
        }
        "stash" => {
            "it takes every card's uncommitted work out of the checkout at once, silently and \
             with no error shown to any of them, and carries no untracked files into the stash \
             it makes.\n\n"
        }
        _ => {
            "it discards uncommitted work across the whole checkout rather than in the paths \
             you named.\n\n"
        }
    });

    msg.push_str("standing in this same tree right now, with work in it:\n\n");
    for s in siblings {
        let short: String = s.conversation_id.chars().take(8).collect();
        if s.title.is_empty() {
            msg.push_str(&format!("  card {short}\n"));
        } else {
            msg.push_str(&format!("  {} ({short})\n", s.title));
        }
    }

    msg.push_str(
        "\nwhat to do instead:\n\n\
         - name what you mean. the pathspec forms are not denied:\n\
         \x20     git checkout <ref> -- <one file>\n\
         \x20     git reset -q -- <one file>\n\
         \x20     git restore -- <one file>\n\
         - reading a stash is fine: `git stash list`, `git stash show`.\n\
         - want a clean tree to work in? make a worktree rather than clearing this one.\n\
         - trying to tell whether a build error is yours? it is faster to ask the card that \
         owns the file — `mcp__skein__board` says who that is and costs nobody a turn.\n\
         - if you genuinely need this command, ask the user rather than working around it.\n",
    );
    msg
}

/// The guard: is this a tree-wide discard, in a tree somebody else is in?
///
/// Cheaper than `sweep`, which has to ask git what is staged — this asks the
/// wall one question and nothing else. Silent for every ordinary case: a card
/// working alone, no database, a card with no id in its settings layer.
fn perilous(command: &str, cwd: Option<&str>, card: &str, db: &std::path::Path) -> Option<String> {
    let tw = tree_wide(command)?;

    /* A `-C` pointing elsewhere is a *different* tree, and this card's siblings
       are the wrong answer about it. Rather than resolve that properly — which
       would mean canonicalizing two paths and being wrong in the direction of a
       false deny — the guard steps aside unless `-C` demonstrably names the
       directory the card is already standing in. That is a hole, and it is the
       safe kind: an unreadable path means allow, never refuse. The case that
       actually happens is a bare `git stash` where the card stands, and the
       system prompt covers the rest (`supervisor::append_prompt`). */
    if let Some(d) = &tw.dir {
        let same = cwd.is_some_and(|c| {
            let there = std::path::Path::new(c).join(d);
            matches!(
                (std::fs::canonicalize(&there), std::fs::canonicalize(c)),
                (Ok(a), Ok(b)) if a == b
            )
        });
        if !same {
            return None;
        }
    }

    let siblings = crate::store::siblings_in_tree(db, card);
    if siblings.is_empty() {
        return None;
    }
    Some(perilous_reason(&tw, &siblings))
}

/* -- deleting by moving instead -------------------------------------------
 *
 * **This is not a deny on deleting; it is a deny on deleting while calling it
 * something else.** Sink `14f2543e` is the whole of the case: `rm -rf .next`
 * was refused, and the card did `mv .next .next-stale-audit-backup`. Same
 * effect at the place it mattered, less legible about intent, and five
 * gigabytes of orphaned junk left on a disk nobody sweeps. The item concluded
 * Volery could not close that hole because "the hole is in that one regex and
 * the regex is not Volery's" -- which is wrong, and this is the correction:
 * `PreToolUse` is Volery's, `deny(reason)` reaches the model even under
 * `--dangerously-skip-permissions`, and the reason can name what to do instead.
 *
 * **The reason is the entire point of the guard**, which is why it names
 * `mcp__skein__remove` rather than merely refusing. `docs/TOOL-SURFACE.md` section 1
 * states the finding this rests on -- *a capability an agent has a habit against
 * is indistinguishable from one that does not exist* -- and neither half is
 * sufficient alone: the deny alone leaves the need unmet, which is precisely
 * the complaint `14f2543e` was filed about, and the tool alone is invisible to
 * an agent that is not searching for it. A `PreToolUse` reason is the only
 * channel here that arrives *at the moment the reflex fires*.
 *
 * **What it deliberately does not do is guard deleting.** The user's own
 * `~/.claude/settings.json` owns that decision and Volery does not duplicate
 * it: two layers refusing the same command is two places to look when something
 * is refused, and a guard whose author is ambiguous is one nobody can change
 * with confidence. See `.claude/rules/remove.md` for what that leaves open,
 * which as measured on 2026-09-10 is a great deal more than anybody expected.
 *
 * **Displacement is the shape, not the verb.** What is caught is a move whose
 * destination is the source with something bolted on -- `.next` to
 * `.next-stale-audit-backup`, `dist` to `dist.old`, `build` to `build.bak` --
 * because that is a delete wearing a rename. An ordinary `mv a b`, a move into
 * a different directory, a rename inside a refactor: none of them match, and
 * that is the property that makes this affordable. A guard that fired on
 * ordinary renames would be one every card learns to route around, and then it
 * guards nothing at all.
 */

/// A move that is a delete with a new name on it.
#[derive(Debug, Clone, PartialEq)]
pub struct Displaced {
    /// What is being moved out of the way, as it was typed.
    pub from: String,
    /// Where to, as it was typed.
    pub to: String,
}

/// The words that make a move a shelving rather than a rename.
///
/// A list rather than "any suffix at all", because `mv config config.local` is
/// an ordinary thing to do and `mv .next .next-stale-audit-backup` is not. What
/// separates them is that these words mean *this one is finished with* -- so the
/// list is short, is about intent, and every entry is a word somebody reaches
/// for when they mean to stop looking at something.
const SHELVED: [&str; 8] = [
    "bak", "backup", "old", "orig", "stale", "delete", "deleted", "trash",
];

/// Does this command line move a directory out of the way instead of deleting it?
///
/// Quote-aware through `commands`, and heredoc-stripped through `strip_heredocs`,
/// for the reasons those two argue: prose about `mv` in a commit message is not
/// a `mv`.
pub fn displaced(command: &str) -> Option<Displaced> {
    commands(&strip_heredocs(command))
        .iter()
        .find_map(|words| displaced_in(words))
}

fn displaced_in(words: &[String]) -> Option<Displaced> {
    let verb = words.first()?.as_str().to_ascii_lowercase();
    /* Both shells, because which one a card is given is not a thing this file
       gets to assume -- measured 2026-09-10 with `tools/probe-rm.ts`, a card
       spawned with Skein's own argv shape had **PowerShell and no Bash at
       all**. `ren`/`rename` are the same act with a third spelling. */
    let named = matches!(
        verb.as_str(),
        "mv" | "move" | "move-item" | "ren" | "rename" | "rename-item"
    );
    if !named {
        return None;
    }
    /* A rename lands in the directory it started in, by definition. A move does
       not, so a bare leaf destination means two different things depending on
       which of the two this is. */
    let renaming = matches!(verb.as_str(), "ren" | "rename" | "rename-item");

    /* **A named parameter's value is an operand, not something to skip**, and
       the first cut of this got that backwards -- `Move-Item -Path target
       -Destination target-stale` had both of its operands eaten by the flag
       handling and the guard fired on nothing. Found by `tools/lift-remove.ts`,
       which is the whole argument for the lift existing: it compiles perfectly
       either way.

       Anything else beginning with `-` is dropped without looking at what
       follows it, which is the conservative direction -- `-Force`, `-Recurse`
       and the POSIX short flags take no value, and a flag this does not know
       costs an operand and therefore a guard that does not fire. */
    let mut positional: Vec<&str> = Vec::new();
    let mut from_named: Option<&str> = None;
    let mut to_named: Option<&str> = None;
    let mut leaf_dest = renaming;
    let mut take: Option<u8> = None;

    for w in words.iter().skip(1) {
        if let Some(slot) = take.take() {
            match slot {
                0 => from_named = Some(w),
                _ => to_named = Some(w),
            }
            continue;
        }
        if let Some(flag) = w.strip_prefix('-') {
            match flag.trim_start_matches('-').to_ascii_lowercase().as_str() {
                "path" | "literalpath" => take = Some(0),
                "destination" => take = Some(1),
                /* `-NewName` is a *leaf*, never a path: `Rename-Item -Path
                   a/b/dist -NewName dist.bak` renames in place. Comparing it
                   against a source that carries directories would find two
                   different parents and step aside on the exact case this is
                   for. */
                "newname" => {
                    take = Some(1);
                    leaf_dest = true;
                }
                _ => {}
            }
            continue;
        }
        positional.push(w);
    }

    let from = from_named.or_else(|| positional.first().copied())?;
    let to = to_named.or_else(|| {
        positional
            .get(if from_named.is_some() { 0 } else { 1 })
            .copied()
    })?;

    /* Re-rooted rather than compared as it stands, so a rename's leaf
       destination is read as the sibling it actually is. */
    let resolved = if leaf_dest && !to.contains('/') && !to.contains(MS_SEP) {
        match from
            .replace(MS_SEP, "/")
            .trim_end_matches('/')
            .rsplit_once('/')
        {
            Some((dir, _)) => format!("{dir}/{to}"),
            None => to.to_string(),
        }
    } else {
        to.to_string()
    };

    is_shelving(from, &resolved).then(|| Displaced {
        from: from.to_string(),
        to: to.to_string(),
    })
}

/// Is `to` the same place as `from` with a shelving word bolted on?
///
/// Pure and separately named because it is the whole of the judgement, and
/// because both directions of it matter: firing on an ordinary rename makes a
/// guard that gets routed around, and not firing on `.next` to
/// `.next-stale-audit-backup` is the exact case this exists for.
pub fn is_shelving(from: &str, to: &str) -> bool {
    let norm = |s: &str| {
        s.replace(MS_SEP, "/")
            .trim_end_matches('/')
            .to_ascii_lowercase()
    };
    let (f, t) = (norm(from), norm(to));
    if f.is_empty() || t.is_empty() || f == t {
        return false;
    }
    /* A move into a *different* directory is not this. Somebody tidying a file
       into a folder is doing something else, and it is legible on its own. */
    let dir_of = |s: &str| {
        s.rsplit_once('/')
            .map(|(d, _)| d.to_string())
            .unwrap_or_default()
    };
    if dir_of(&f) != dir_of(&t) {
        return false;
    }
    let Some(tail) = t.strip_prefix(&f) else {
        return false;
    };
    /* What is left over after the original name. `.next-stale-audit-backup`
       leaves `-stale-audit-backup`; `configuration` over `config` leaves
       `uration`, which carries no separator and is a different word rather than
       a suffix on the same one. */
    let tail = tail.trim_start_matches(SEPS);
    if tail.is_empty() {
        return false;
    }
    tail.split(SEPS).any(|w| SHELVED.contains(&w))
}

/// The separators a shelving suffix is bolted on with.
const SEPS: [char; 4] = ['-', '_', '.', ' '];

/// Windows' own separator, as a `char`, so no string literal in this file has to
/// carry an escaped one -- the Bash tool halves runs of backslashes and this
/// module is the one that exists because of it.
const MS_SEP: char = '\u{5c}';

/// What to say when a card shelves a directory instead of deleting it.
///
/// `sweep_reason`'s contract -- **the escape from a wrong answer is named in the
/// refusal** -- with one difference worth stating, because it is the difference
/// this guard exists for: the alternative here is not a spelling of the same
/// command, it is a *different tool*, and a card that has never heard of it
/// cannot find it by trying harder. So the tool is named in full, with what it
/// does, in the sentence a card reads at the moment it is stopped.
pub fn displaced_reason(d: &Displaced) -> String {
    format!(
        "volery: `{from}` -> `{to}` is a delete with a rename on it.\n\n\
         moving a directory aside has the same effect as removing it -- the tree is gone from \
         where it mattered -- while saying less about what you meant, and it leaves the whole \
         of it on disk for nobody to sweep up. sink `14f2543e` is the last time this happened \
         and the reason this guard exists: 5.3 GB of `.next` under a `-stale-audit-backup` \
         suffix that is still there.\n\n\
         what to do instead:\n\n\
         - **`mcp__skein__remove`** deletes it properly, behind one click from the user. it \
         shows them the absolute path, its size and file count, whether git tracks it, \
         whether another card on this wall has been writing in it, and whether a dev server \
         is running out of that tree -- then they press a button. that is the sanctioned \
         route, and it exists because deleting from a card is the user's decision rather \
         than yours.\n\
         - genuinely renaming something? name a destination that is not your own path with \
         one of `{shelved}` on the end -- this guard fires on nothing else.\n\
         - moving it somewhere else entirely is not this either, and is not denied.\n",
        from = d.from,
        to = d.to,
        shelved = SHELVED.join("`/`"),
    )
}

/* -- deleting a tree, which is the user's decision and not a card's ---------
 *
 * **This guard exists because the one everybody believed in was measured and
 * was not there.** The user's `~/.claude/settings.json` denies
 * `Bash(rm -rf:*)`, deliberately and on a stated intent -- *cards must not be
 * able to delete without my approval* -- and `docs/TOOL-SURFACE.md` section 2
 * reasoned from it at length, as did sink `14f2543e`, as did the brief that
 * built `remove.rs`. All of them assumed it fired.
 *
 * `tools/probe-rm.ts`, 2026-09-10, claude 2.1.241, one real turn with Skein's
 * own argv shape and that deny list verbatim:
 *
 *     shell tools the card was given: PowerShell
 *     SURVIVED  rm -rf a-rm-rf        Remove-Item: no parameter matches 'rf'
 *     SURVIVED  rm -fr b-rm-fr        Remove-Item: no parameter matches 'fr'
 *     SURVIVED  rm -r -f c-rm-r-f     'f' is ambiguous: -Filter, -Force
 *     SURVIVED  rm --recursive ...    no positional parameter accepts '--force'
 *     DELETED   find e-find-delete -delete
 *     DELETED   Remove-Item -Recurse -Force g-remove-item
 *
 * **Not one call was refused by a permission rule.** A card here has no `Bash`
 * tool at all -- it asked for one by name and answered "NO BASH TOOL" -- so
 * `Bash(rm -rf:*)` matches nothing it can call. The four that survived did so
 * because PowerShell's `rm` is an alias for `Remove-Item`, which rejects POSIX
 * flags before any deletion is contemplated. That is a shell incompatibility
 * wearing a guard's clothes, and it holds for exactly as long as nobody types
 * the spelling that works.
 *
 * So this is Volery's, added 2026-09-10 with the user's explicit approval,
 * because a new denial every card on the wall is subject to is not a thing to
 * add and mention afterwards. It covers the **family** rather than the two
 * spellings that got through the probe: a guard catching two of five spellings
 * is the precise failure it is being added to fix.
 *
 * **The reason is the point, not the refusal.** It names `mcp__skein__remove`,
 * which asks the user and then deletes properly -- so the card is not stopped,
 * it is redirected, and `14f2543e`'s complaint (*"a guard that is both
 * obstructive and bypassable is the worst of the three options"*) does not
 * apply to a guard that hands over a working route. `docs/TOOL-SURFACE.md`
 * section 1 is the argument for why the reason has to arrive here rather than
 * in a schema: a `PreToolUse` deny is the only channel that speaks at the
 * moment the reflex fires.
 *
 * **The user's own rule is untouched and still comes first.** It is the Bash
 * tool's, this is every shell's, and the two are told apart by the one word
 * every reason in this file opens with.
 */

/// A command that removes a directory tree.
#[derive(Debug, Clone, PartialEq)]
pub struct Wipe {
    /// The command as it was typed, for a refusal that quotes it back.
    pub verb: String,
}

/// Every spelling of `Remove-Item` a card might reach for.
///
/// PowerShell aliases `rm`, `del`, `erase`, `rd`, `rmdir` and `ri` all to the
/// same cmdlet, so the *name* separates none of them and only the switch does.
const REMOVERS: [&str; 7] = ["remove-item", "ri", "rm", "del", "erase", "rd", "rmdir"];

/// The switches that make a delete reach a whole tree.
///
/// `rf`/`fr` are in here as whole tokens because POSIX bundles its short flags,
/// and a card that does get a Bash tool writes them that way.
const RECURSIVE: [&str; 8] = ["r", "recurse", "recursive", "rf", "fr", "rfv", "s", "force"];

/// Does this command line delete a tree?
///
/// Quote-aware through `commands` and heredoc-stripped through `strip_heredocs`,
/// for the reason those two argue: prose about `rm -rf` in a commit message is
/// not an `rm -rf`, and this file's own documentation is now full of it.
pub fn wipes(command: &str) -> Option<Wipe> {
    commands(&strip_heredocs(command))
        .iter()
        .find_map(|words| wipes_in(words))
}

fn wipes_in(words: &[String]) -> Option<Wipe> {
    let verb = words.first()?.as_str().to_ascii_lowercase();
    let verb = verb.rsplit(['/', MS_SEP]).next().unwrap_or(&verb).to_string();

    /* `find … -delete` and `find … -exec rm`, which is the one that has actually
       happened here: it contains no `rm` at all in the first form, deletes a
       tree, and is what got past the deny in the probe above. */
    if verb == "find" {
        let deletes = words.iter().skip(1).any(|w| {
            let w = w.to_ascii_lowercase();
            w == "-delete" || w == "-exec" || w == "-execdir" || w == "-ok"
        });
        return deletes.then(|| Wipe { verb: "find".into() });
    }

    if !REMOVERS.contains(&verb.as_str()) {
        return None;
    }

    /* A switch rather than a name, since every remover above is the same cmdlet
       and only this tells a file delete from a tree delete. `/s` is cmd.exe's
       spelling of the same thing and reaches this file through the same shell. */
    let recursive = words.iter().skip(1).any(|w| {
        let bare = w
            .trim_start_matches('/')
            .trim_start_matches('-')
            .trim_start_matches('-')
            .to_ascii_lowercase();
        (w.starts_with('-') || w.starts_with('/')) && RECURSIVE.contains(&bare.as_str())
    });
    /* An operand is required: a bare `rm -rf` with nothing after it deletes
       nothing and is almost always a half-written line. */
    let names_something = words
        .iter()
        .skip(1)
        .any(|w| !w.starts_with('-') && !w.starts_with('/'));

    (recursive && names_something).then(|| Wipe { verb })
}

/// What to say when a card deletes a tree from the shell.
///
/// `sweep_reason`'s contract, and the one place in this file where the escape is
/// a *different tool* rather than a different spelling: a card that has never
/// heard of `mcp__skein__remove` cannot find it by trying harder, so the tool is
/// named in full, with what it does, in the sentence the card reads at the
/// moment it is stopped.
pub fn wipe_reason(w: &Wipe) -> String {
    format!(
        "volery: `{verb}` deletes a tree, and on this wall that is the user's decision \
         rather than yours.\n\n\
         this is not a refusal to delete -- it is a refusal to delete *without asking*. there \
         is a tool for it and it does the whole job:\n\n\
         - **`mcp__skein__remove`** takes the path and a reason, puts it in front of the user \
         with everything they cannot see from a path -- the absolute path, its size and file \
         count, whether git tracks it, whether another card on this wall has been writing in \
         it, whether a dev server is running out of that tree -- and deletes it when they \
         press the button. one call from you, one click from them.\n\
         - it refuses on its own, with or without a click, anything holding uncommitted \
         tracked changes, anything under `.git`, a work-tree root, a territory root, and the \
         directory you are standing in. so it is safe to reach for without checking first.\n\
         - **do not look for a spelling that gets past this.** `mv`-ing the directory aside \
         is denied too and for the same reason; the last card that did it left 5.3 GB on \
         disk under a `-stale-audit-backup` suffix (sink `14f2543e`). deleting one file, \
         non-recursively, is not denied at all.\n",
        verb = w.verb,
    )
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
    let source = payload.get("source").and_then(serde_json::Value::as_str);
    let path = std::path::Path::new(db);
    let now = crate::store::now();

    /* **Two questions on one occasion, and they do not want the same
       occasions.** Background work is only worth raising when the context has
       demonstrably just lost it; a red gate is worth raising whenever the card
       is about to do something, and most of all the first time it speaks. So
       each is asked for separately below and whatever answers is joined. */
    let mut parts: Vec<String> = Vec::new();

    /* **Only the compaction firing, for the jobs, and the test is here rather
       than in a matcher.** `SessionStart` also fires on `startup`, `resume` and
       `clear`, and none of those wants this: at startup there is no context to
       have lost, and a resumed card is exactly the case `rouse` already handles
       — it sends `resumePrompt` or `jobsPrompt` naming the lost jobs and then
       deletes the rows. Answering here as well would say it twice, in two
       different voices, about the same work. */
    let jobs_wanted = event != "SessionStart" || source == Some("compact");
    if jobs_wanted {
        if let Some(session) = payload.get("session_id").and_then(serde_json::Value::as_str) {
            let jobs = crate::store::outstanding_jobs(path, card, session);
            if let Some(text) = standing_work(&jobs, event == "SessionStart", now) {
                parts.push(text);
            }
        }
    }

    /* **Every occasion, for the gates, including a plain `startup`** — which is
       the one difference from the rule above and the whole point of the feature.
       A card arriving in a tree somebody else has already broken is the case
       sink 3ebe1d59 is about: on 2026-08-27 three cards each discovered the same
       breakage alone, one broadcast it to the whole wall at a turn apiece and
       then had to retract it, and a fourth ran `git stash` in a shared checkout
       while trying to work out whether the error was its own. All of that is one
       fact nobody could read, and the cheapest moment to hand it over is before
       the first turn is spent. `cwd` is on every payload, and it is the tree the
       card is actually standing in rather than the one its row remembers. */
    if let Some(root) = payload.get("cwd").and_then(serde_json::Value::as_str) {
        let runs = crate::store::gates_in_tree(path, root);
        if let Some(text) = standing_gates(&runs, card, now) {
            parts.push(text);
        }
    }

    if parts.is_empty() {
        return None;
    }
    Some(
        serde_json::json!({
            "hookSpecificOutput": {
                "hookEventName": event,
                "additionalContext": parts.join("\n\n"),
            }
        })
        .to_string(),
    )
}

/// How stale an observation may be and still be worth handing to a card.
///
/// **A stale green presented as current is what made a broadcast need
/// retracting**, and a stale red is the same error with the sign flipped: a card
/// told the tree was broken yesterday goes hunting a bug somebody fixed
/// overnight, which costs it exactly the turn this is trying to save. Six hours
/// is about a working session — long enough to cover a card that arrives in the
/// afternoon to a tree broken before lunch, short enough that nothing here ever
/// speaks about yesterday.
const GATE_STALE_MS: i64 = 6 * 60 * 60 * 1000;

/// How long an unsettled run may stand before it is more likely orphaned.
///
/// A row with no result is either a gate running right now or one whose end
/// nobody ever saw — the app was closed, the card was interrupted, the process
/// died. The two are indistinguishable from here and only time tells them apart
/// at all. Ten minutes is generous against a warm `cargo check --lib` at ~19s
/// (`.claude/rules/build.md`) and a full `bun run test` at ~6s, so a row older
/// than this is treated as nothing rather than announced as work in flight.
const GATE_RUNNING_MS: i64 = 10 * 60 * 1000;

/// What this card ought to know about the gates in the tree it is standing in,
/// before it spends a turn finding out. Pure, so it can be lifted and run.
///
/// **Only ever about somebody else's observation.** Telling a card about a red
/// gate it watched go red itself is noise — it was there. Every branch below is
/// therefore conditioned on another card having been the observer, which is also
/// what makes the answer worth a context slot at all: it is the thing this card
/// provably cannot know.
///
/// **The repetition problem, and the read-only bound on it.** `UserPromptSubmit`
/// fires on every prompt, so an unconditional reading would repeat itself for as
/// long as the gate stayed red. The billboard solves the same problem with
/// `notice_served`, and that is a *write* — which this cannot be, because a hook
/// is a short-lived second process and `hooks.md` is explicit that it stays a
/// reader. So the bound is one that can be computed from the rows themselves:
/// **nothing is said about a gate this card has since observed for itself.** The
/// moment it runs the gate, it knows first-hand and this falls silent, which is
/// self-limiting and needs no state. What it costs is a repeat over the handful
/// of prompts between arriving and running the gate; if that proves noisy the
/// fix is `notice_served`'s shape and a writer to go with it, not a wider
/// silence here.
pub fn standing_gates(
    runs: &[crate::store::GateRun],
    me: &str,
    now: i64,
) -> Option<String> {
    let mut lines: Vec<String> = Vec::new();

    /* Rows arrive newest-first from `gates_of`, but sorting is not trusted:
       this reads "the first settled row for this gate" as the current state,
       and one row out of order would invert the answer. */
    let mut gates: Vec<&str> = Vec::new();
    for r in runs {
        if !gates.contains(&r.gate.as_str()) {
            gates.push(r.gate.as_str());
        }
    }

    for gate in gates {
        let mut of_gate: Vec<&crate::store::GateRun> =
            runs.iter().filter(|r| r.gate == gate).collect();
        of_gate.sort_by_key(|r| -(r.settled_at.unwrap_or(r.started_at)));

        let settled: Vec<&&crate::store::GateRun> =
            of_gate.iter().filter(|r| r.outcome != "unknown").collect();

        /* **The silence that makes this bearable.** If this card has settled a
           run of this gate more recently than anybody else has, it is the one
           holding the freshest information and has nothing to learn. */
        if settled.first().is_some_and(|r| r.card == me) {
            continue;
        }

        /* Somebody is running it right now, which is worth saying on its own:
           two cards starting cargo at once is where `Blocking waiting for file
           lock on package cache` came from that afternoon. */
        if let Some(live) = of_gate.iter().find(|r| {
            r.outcome == "unknown"
                && r.settled_at.is_none()
                && r.card != me
                && now - r.started_at < GATE_RUNNING_MS
        }) {
            lines.push(format!(
                "  {} — {} is running it right now (started {} ago). Wait for that rather \
                 than starting a second one; cargo and bun both take a lock.",
                gate,
                who(live),
                ago(now - live.started_at),
            ));
            continue;
        }

        let Some(last) = settled.first() else { continue };
        if last.outcome != "failed" {
            continue;
        }
        let at = last.settled_at.unwrap_or(last.started_at);
        if now - at > GATE_STALE_MS {
            continue;
        }

        let scope = if last.scope == "partial" {
            format!(" (only {}, so this may not be the whole gate)", last.narrowed.as_deref().unwrap_or("part of it"))
        } else {
            String::new()
        };
        lines.push(format!(
            "  {} was RED {} ago{}, run by {} — not by you.\n     $ {}",
            gate,
            ago(now - at),
            scope,
            who(last),
            last.command,
        ));
        if let Some(d) = &last.detail {
            /* The tail only, and indented, so it reads as quoted output rather
               than as something Volery is asserting. */
            let tail: Vec<&str> = d.lines().rev().take(3).collect();
            for l in tail.into_iter().rev() {
                lines.push(format!("     | {l}"));
            }
        }
        /* Flapping is the third waste of that afternoon named directly: the same
           `cargo update --precise` pin applied and lost three times, with each
           card assuming a sibling had undone its fix when all three were losing
           to cargo. Nobody could see the gate going green and red again. */
        let changes = settled
            .windows(2)
            .filter(|w| w[0].outcome != w[1].outcome)
            .count();
        if changes > 1 {
            lines.push(format!(
                "     this gate has gone green and red {changes} times here — before assuming a \
                 sibling undid a fix, check whether the fix survives (a `cargo update --precise` \
                 pin does not; it is re-resolved by the next resolve)."
            ));
        }
    }

    if lines.is_empty() {
        return None;
    }
    let mut s = String::from("<volery-gate-health>\n");
    s.push_str(
        "Another card in this working tree has already observed this. You did not cause it and \
         you do not need to prove that you did not.\n\n",
    );
    s.push_str(&lines.join("\n"));
    /* **It used to end by forbidding `git stash` here as well, and that was the
       rule's third statement.** The system prompt says it once at spawn;
       `perilous_reason` says it at the moment of the reflex and *refuses the
       call*, which is the half that works on a card chasing a build error. This
       said it a third time, in bold, on every `UserPromptSubmit` while any gate
       in the tree was red — which is the reading an agent meets most often and
       the one that can do least about it. Three shouted copies of one rule is
       one rule nobody hears, and emphasis only works if it is rare (sink
       `4dabbb75`).

       The deny stays, and the counter-argument for keeping it is good and is on
       record in `append_prompt`: an instruction does not bind a reflex. That
       argues for the enforcement, not for a third reminder beside it. */
    s.push_str(
        "\n\nThis is what was *observed*, attributed and timestamped — not a claim about the \
         tree right now. Volery only ever sees gates run by cards on this wall, so a gate not \
         listed here has not been proved green.\n\
         </volery-gate-health>",
    );
    Some(s)
}

/// A card by name where there is one, by short id where there is not.
///
/// The fallback matters more here than it looks: this table deliberately keeps
/// no foreign key, so the commonest reason a name is missing is that the card
/// which made the observation has closed — which is exactly when the
/// observation is most worth having, and exactly when there is nobody to ask.
fn who(r: &crate::store::GateRun) -> String {
    match r.card_name.as_deref() {
        Some(t) if !t.is_empty() && t != "untitled" => format!("\"{t}\""),
        _ => format!("card {}", r.card.chars().take(8).collect::<String>()),
    }
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
    fn a_directory_moved_out_of_its_own_way_is_a_delete() {
        /* The command sink `14f2543e` actually ran, verbatim. */
        let d = displaced("mv .next .next-stale-audit-backup").expect("not caught");
        assert_eq!(d.from, ".next");
        assert_eq!(d.to, ".next-stale-audit-backup");

        /* The ordinary spellings of the same act, including the two a card with
           only a PowerShell tool would reach for. */
        assert!(displaced("mv dist dist.old").is_some());
        assert!(displaced("Move-Item build build.bak").is_some());
        assert!(displaced("move-item -Path target -Destination target-stale").is_some());
        assert!(displaced("ren node_modules node_modules.orig").is_some());
        assert!(displaced("Rename-Item .turbo .turbo-delete-me").is_some());

        /* The named-parameter form, which is what an agent writing PowerShell
           actually types — and which the first cut of `displaced_in` missed
           entirely, because it skipped a flag's value as though every flag were
           `-Force`. `tools/lift-remove.ts` found it; a typecheck cannot. */
        let d = displaced("Move-Item -Path target -Destination target-stale").expect("named form");
        assert_eq!(d.from, "target");
        assert_eq!(d.to, "target-stale");

        /* `-NewName` is a leaf rather than a path, so a source carrying
           directories has to be re-rooted before the two are compared or the
           parents differ and the guard steps aside on its own case. */
        let d = displaced("Rename-Item -Path apps/web/.next -NewName .next.bak").expect("newname");
        assert_eq!(d.from, "apps/web/.next");
        assert_eq!(d.to, ".next.bak");

        /* A flag with no value, between the operands. */
        assert!(displaced("Move-Item -Force dist dist.old").is_some());
    }

    #[test]
    fn every_spelling_that_deletes_a_tree_is_caught() {
        /* The two the probe watched delete a directory with no refusal
           whatsoever, 2026-09-10. */
        assert!(wipes("Remove-Item -Recurse -Force .next").is_some());
        assert!(wipes("find .next -delete").is_some());

        /* And the rest of the family, because a guard catching two of five
           spellings is the failure this was added to fix. */
        assert!(wipes("rm -rf node_modules").is_some());
        assert!(wipes("rm -fr dist").is_some());
        assert!(wipes("rm -r -f build").is_some());
        assert!(wipes("rm --recursive --force target").is_some());
        assert!(wipes("rm -Recurse -Force .turbo").is_some());
        assert!(wipes("del -Recurse coverage").is_some());
        assert!(wipes("rd /s /q dist").is_some());
        assert!(wipes("rmdir /s dist").is_some());
        assert!(wipes("find . -name '*.log' -exec rm {} ;").is_some());

        /* On a chained line, which is how it usually arrives. */
        assert!(wipes("cd apps/web && rm -rf .next && pnpm dev").is_some());
        /* And through a path, since `C:\\tools\\rm.exe` is the same act. */
        assert!(wipes("/usr/bin/rm -rf dist").is_some());
    }

    #[test]
    fn deleting_one_file_is_not_this() {
        /* The line the guard has to keep, or it is a guard on `rm` and every
           card learns to route around it. A non-recursive delete of a named
           file is ordinary work. */
        assert!(wipes("rm notes.txt").is_none());
        assert!(wipes("rm -f notes.txt").is_none());
        assert!(wipes("Remove-Item stale.log").is_none());
        assert!(wipes("del package-lock.json").is_none());
        /* A `find` that only reads. */
        assert!(wipes("find . -name '*.ts'").is_none());
        /* A remover naming nothing is a half-written line, not a delete. */
        assert!(wipes("rm -rf").is_none());
        /* And prose about it is prose. */
        assert!(wipes("echo 'rm -rf is denied'").is_none());
        assert!(wipes("grep -r rm src/").is_none());
    }

    #[test]
    fn the_wipe_refusal_hands_over_a_working_route() {
        let why = wipe_reason(&wipes("Remove-Item -Recurse -Force .next").unwrap());
        /* Sink `14f2543e`: *a guard that is both obstructive and bypassable is
           the worst of the three options*. This one is neither, and the reason
           is what makes that true — it names the tool that does the job. */
        assert!(why.contains("mcp__skein__remove"), "{why}");
        assert!(why.contains("not a refusal to delete"), "{why}");
        /* It says the tool refuses on its own, so a card does not go and check
           the tree by hand before daring to call it. */
        assert!(why.contains("uncommitted"), "{why}");
        /* And it closes the door the last card went through. */
        assert!(why.contains("spelling that gets past"), "{why}");
        assert!(why.contains("`mv`"), "{why}");
        /* Every reason in this file opens with the one word that says which
           layer refused — the user's own deny rule is untouched and says
           nothing of the kind. */
        assert!(why.starts_with("volery:"), "{why}");
    }

    #[test]
    fn a_wipe_written_into_a_commit_message_is_prose() {
        /* `strip_heredocs`' reason, and it bites hardest here: this repository's
           documentation is now full of `rm -rf`, and the house style writes a
           commit message on stdin from a heredoc. */
        let command = "git commit -F - -- src/x.rs <<'EOF'\n\
                       skein: a guard for rm -rf and Remove-Item -Recurse -Force dist\n\
                       EOF";
        assert!(wipes(command).is_none());
    }

    #[test]
    fn an_ordinary_rename_is_left_alone() {
        /* The property that makes the guard affordable. A guard that fired on
           these is one every card learns to route around, and then it guards
           nothing at all. */
        assert!(displaced("mv a b").is_none());
        assert!(displaced("mv config config.local").is_none());
        assert!(displaced("mv src/lib/theme.ts src/lib/palette.ts").is_none());
        assert!(displaced("mv notes.md docs/notes.md").is_none());
        /* A move to somewhere else entirely, even under a shelving name: that is
           legible on its own and leaves nothing where it was. */
        assert!(displaced("mv .next /tmp/next-old").is_none());
        /* A longer word that merely starts with the source name. */
        assert!(!is_shelving("config", "configuration"));
        assert!(!is_shelving("dist", "distribution"));
        /* And the degenerate ones. */
        assert!(!is_shelving("dist", "dist"));
        assert!(!is_shelving("", "dist.bak"));
    }

    #[test]
    fn shelving_is_read_the_way_the_filesystem_reads_a_path() {
        assert!(is_shelving(".next", ".NEXT-BACKUP"));
        assert!(is_shelving("a/b/dist", "a/b/dist.old"));
        assert!(is_shelving("dist/", "dist-stale"));
        /* A different directory is a different act, whatever the suffix says. */
        assert!(!is_shelving("a/dist", "b/dist.old"));
    }

    #[test]
    fn the_move_guard_is_not_a_delete_guard() {
        /* Volery's guards are Volery's and the user's are the user's. A second
           copy of `rm -rf` over here would be two places to look when something
           is refused, and a refusal whose author is ambiguous is one nobody can
           change with confidence. */
        assert!(displaced("rm -rf .next").is_none());
        assert!(displaced("Remove-Item -Recurse -Force .next").is_none());
        assert!(displaced("find . -delete").is_none());
    }

    #[test]
    fn the_refusal_names_the_tool_and_the_way_back() {
        let d = displaced("mv .next .next-stale-audit-backup").unwrap();
        let why = displaced_reason(&d);
        /* The whole point of the guard rather than a nicety: `TOOL-SURFACE` §1
           is that a capability an agent has a habit against is indistinguishable
           from one that does not exist, and a `PreToolUse` reason is the only
           channel that arrives when the habit fires. */
        assert!(why.contains("mcp__skein__remove"), "{why}");
        assert!(why.contains(".next-stale-audit-backup"), "{why}");
        /* `sweep_reason`'s contract: the escape is in the refusal, so there is
           nothing for the next agent to go looking for a spelling around. */
        assert!(why.contains("moving it somewhere else"), "{why}");
        assert!(why.contains("renaming"), "{why}");
    }

    #[test]
    fn the_move_guard_holds_where_the_other_two_step_aside() {
        /* `perilous` and `sweep` both need a card and a database. This one is a
           judgement about the command line alone, so it must still fire on a
           payload that names neither -- which is what a spawn with no card
           gives it. */
        let payload = r#"{"tool_name":"Bash","tool_input":{"command":"mv dist dist.bak"}}"#;
        let said = reply(payload, None, None).expect("said nothing");
        assert!(said.contains("mcp__skein__remove"), "{said}");
        assert!(said.contains("\"permissionDecision\":\"deny\""), "{said}");
    }

    #[test]
    fn a_shelving_written_into_a_commit_message_is_prose() {
        /* `strip_heredocs`' reason, arriving for the third guard: this
           repository's own prose talks about `mv .next .next-stale-audit-backup`
           constantly now, and a commit message carrying that sentence must not
           deny the commit it is attached to. */
        let command = "git commit -F - -- src/x.rs <<'EOF'\n\
                       skein: a guard for mv .next .next-stale-audit-backup\n\
                       EOF";
        assert!(displaced(command).is_none());
    }

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
        let v: serde_json::Value = serde_json::from_str(&settings(false, None, false)).unwrap();
        let h = &v["hooks"]["PreToolUse"][0];
        /* No matcher: the Windows shell tool was renamed once already and a
           matcher that stops matching says nothing when it does. See the
           module note. */
        assert!(h.get("matcher").is_none(), "a matcher is a name that can rot");
        assert_eq!(h["hooks"][0]["type"], "command");
        assert_eq!(h["hooks"][0]["args"][0], FLAG);
        assert_eq!(h["hooks"][0]["args"].as_array().unwrap().len(), 1);
        assert!(v.get("permissions").is_none(), "a project card gets no allow list");

        let chat: serde_json::Value = serde_json::from_str(&settings(true, None, false)).unwrap();
        assert_eq!(chat["permissions"]["allow"][0], "WebSearch");
        assert_eq!(chat["hooks"]["PreToolUse"][0]["hooks"][0]["type"], "command");
    }

    /// The read-only lock, which is three names in an array and the whole of the
    /// enforcement (sink `8dde1cc1`).
    ///
    /// **Asserted exactly**, both the set and its absence. A deny that lost a
    /// name is a lock that is on and does not hold, and there is nothing to
    /// notice from outside: the switch is still drawn, the settings JSON is
    /// still valid, and the card edits the repository. The unlocked arm matters
    /// as much — a `permissions` key appearing on every project card would be a
    /// change to what every card on the wall can do, arriving from a feature
    /// nobody turned on.
    #[test]
    fn a_locked_territory_denies_the_three_editing_tools_and_nothing_else() {
        let open: serde_json::Value = serde_json::from_str(&settings(false, None, false)).unwrap();
        assert!(open.get("permissions").is_none(), "an unlocked card is granted nothing");

        let shut: serde_json::Value = serde_json::from_str(&settings(false, None, true)).unwrap();
        let deny = shut["permissions"]["deny"].as_array().expect("a deny list");
        assert_eq!(
            deny.iter().filter_map(|d| d.as_str()).collect::<Vec<_>>(),
            vec!["Edit", "Write", "NotebookEdit"]
        );
        /* And the shell is not in it, deliberately and pending a decision — a
           card with no `git log` and no `bun test` is broken rather than
           read-only. Sink `b3230b03`. Asserted in the negative so that adding it
           is a choice somebody makes here rather than a line that slips in. */
        for name in ["Bash", "PowerShell"] {
            assert!(
                !deny.iter().any(|d| d.as_str().is_some_and(|t| t.starts_with(name))),
                "the shell was denied without the question being settled: {deny:?}"
            );
        }
        /* The hook is still registered on a locked card. It carries the
           backslash compensator and the shared-index guard, neither of which
           has anything to do with the lock, and a card that lost them by being
           locked would be a second feature turning off a first. */
        assert_eq!(shut["hooks"]["PreToolUse"][0]["hooks"][0]["type"], "command");
    }

    /// The two occasions a card is handed back the background work it may have
    /// forgotten. Registered against the same binary with the same argv, and —
    /// like `PreToolUse` — with no matcher, so nothing can quietly stop matching.
    #[test]
    fn the_two_forgetting_hooks_are_registered_the_same_way() {
        let v: serde_json::Value = serde_json::from_str(&settings(false, None, false)).unwrap();
        for ev in ["SessionStart", "UserPromptSubmit"] {
            let h = &v["hooks"][ev][0];
            assert!(h.get("matcher").is_none(), "{ev}: a matcher is a name that can rot");
            assert_eq!(h["hooks"][0]["type"], "command", "{ev}");
            assert_eq!(h["hooks"][0]["args"][0], FLAG, "{ev}");
        }
        /* A chat card gets them too. It can run nothing, so it will never have a
           row — but the registration must not be the thing that decides that,
           or the day a chat card gains a tool the guard is silently absent. */
        let chat: serde_json::Value = serde_json::from_str(&settings(true, None, false)).unwrap();
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

    /* ── the gates ─────────────────────────────────────────────────────────
     *
     * Sink 3ebe1d59. These are the words a card actually reads, so they are
     * asserted rather than eyeballed — and `.claude/rules/build.md`'s lift
     * trick runs them for real (`tools/lift-gates.ts`), because a clean
     * `check-gnu.sh` says nothing whatever about whether a sentence is right.
     */

    const ME: &str = "aaaaaaaa-1111-4111-8111-111111111111";
    const OTHER: &str = "bbbbbbbb-2222-4222-8222-222222222222";

    fn gate_run(
        card: &str,
        gate: &str,
        outcome: &str,
        settled: Option<i64>,
        started: i64,
    ) -> crate::store::GateRun {
        crate::store::GateRun {
            tool_id: format!("toolu_{card}_{gate}_{started}"),
            card: card.to_string(),
            card_name: Some(if card == ME { "mine".into() } else { "lucid otter".into() }),
            root: "C:/w/skein".to_string(),
            gate: gate.to_string(),
            scope: "whole".to_string(),
            narrowed: None,
            command: format!("bun run {gate}"),
            started_at: started,
            settled_at: settled,
            outcome: outcome.to_string(),
            detail: None,
        }
    }

    /// The quiet path again, and it has to be the common one here too: a tree
    /// nobody has run a gate in says nothing, and neither does a green one.
    #[test]
    fn a_healthy_tree_is_silent() {
        let now = 1_000_000;
        assert!(standing_gates(&[], ME, now).is_none());
        assert!(
            standing_gates(&[gate_run(OTHER, "test", "passed", Some(now - 1000), now - 2000)], ME, now)
                .is_none(),
            "a green gate is not news"
        );
    }

    /// The whole point: a card arriving to a tree somebody else broke is told
    /// so, told who, and told that it is not its own doing.
    #[test]
    fn a_red_gate_somebody_else_saw_is_handed_over_with_its_provenance() {
        let now = 1_000_000;
        let out = standing_gates(
            &[gate_run(OTHER, "cargo-check", "failed", Some(now - 60_000), now - 70_000)],
            ME,
            now,
        )
        .unwrap();
        assert!(out.contains("cargo-check was RED"), "{out}");
        assert!(out.contains("1m ago"), "{out}");
        assert!(out.contains("lucid otter"), "{out}");
        assert!(out.contains("not by you"), "{out}");
    }

    /// **The bound that makes this bearable on every prompt.** `UserPromptSubmit`
    /// fires per prompt, and a hook cannot write, so it cannot mark a notice
    /// served the way the billboard does. The read-only substitute is that a card
    /// which has since observed the gate itself is the one holding the freshest
    /// information and is told nothing.
    #[test]
    fn a_card_that_has_since_run_the_gate_itself_is_told_nothing() {
        let now = 1_000_000;
        let runs = vec![
            gate_run(OTHER, "cargo-check", "failed", Some(now - 60_000), now - 70_000),
            gate_run(ME, "cargo-check", "failed", Some(now - 10_000), now - 20_000),
        ];
        assert!(
            standing_gates(&runs, ME, now).is_none(),
            "it watched this go red itself; saying so again is noise"
        );
    }

    /// And the inverse, which is the case that must not be silenced with it: my
    /// observation is *older* than theirs, so theirs is still news.
    #[test]
    fn an_older_observation_of_mine_does_not_silence_a_newer_one_of_theirs() {
        let now = 1_000_000;
        let runs = vec![
            gate_run(ME, "cargo-check", "passed", Some(now - 600_000), now - 610_000),
            gate_run(OTHER, "cargo-check", "failed", Some(now - 60_000), now - 70_000),
        ];
        assert!(standing_gates(&runs, ME, now).unwrap().contains("RED"));
    }

    /// **A stale red is the same error as a stale green with the sign flipped.**
    /// The broadcast that had to be retracted was retracted for being out of
    /// date; a card sent hunting a bug somebody fixed overnight loses exactly
    /// the turn this exists to save.
    #[test]
    fn nothing_here_speaks_about_yesterday() {
        let now = 100 * 60 * 60 * 1000;
        let old = now - GATE_STALE_MS - 1;
        assert!(standing_gates(&[gate_run(OTHER, "test", "failed", Some(old), old)], ME, now).is_none());
    }

    /// Rows are sorted here rather than trusted, because one row out of order
    /// inverts the answer — and the two writers of this table (the fold as it
    /// happens, a restore reading it back) have no reason to agree on order.
    #[test]
    fn the_newest_settled_run_decides_and_order_is_not_trusted() {
        let now = 1_000_000;
        let red = gate_run(OTHER, "test", "failed", Some(now - 100_000), now - 110_000);
        let green = gate_run(OTHER, "test", "passed", Some(now - 10_000), now - 20_000);
        for runs in [vec![red.clone(), green.clone()], vec![green, red]] {
            assert!(
                standing_gates(&runs, ME, now).is_none(),
                "the latest word is green, so there is nothing to say"
            );
        }
    }

    /// A gate in flight is its own reading, and it exists to stop the thing that
    /// actually happened: two cards starting cargo at once, and `Blocking
    /// waiting for file lock on package cache` all afternoon.
    #[test]
    fn a_gate_running_right_now_says_so_rather_than_saying_nothing() {
        let now = 1_000_000;
        let out =
            standing_gates(&[gate_run(OTHER, "cargo-check", "unknown", None, now - 30_000)], ME, now)
                .unwrap();
        assert!(out.contains("running it right now"), "{out}");
        assert!(out.contains("take a lock"), "{out}");
        assert!(out.contains("lucid otter"), "{out}");
    }

    /// An unsettled row is either a live run or one whose end nobody ever saw —
    /// the app was closed, the card interrupted, the process died. Only time
    /// tells them apart at all, so past the bound it is treated as nothing
    /// rather than announced as work in flight.
    #[test]
    fn an_ancient_unsettled_row_is_not_announced_as_running() {
        let now = 10_000_000;
        let then = now - GATE_RUNNING_MS - 1;
        assert!(standing_gates(&[gate_run(OTHER, "test", "unknown", None, then)], ME, now).is_none());
    }

    /// My own run is never reported back to me, in either state.
    #[test]
    fn my_own_work_is_not_narrated_to_me() {
        let now = 1_000_000;
        assert!(standing_gates(&[gate_run(ME, "test", "unknown", None, now - 1000)], ME, now).is_none());
        assert!(
            standing_gates(&[gate_run(ME, "test", "failed", Some(now - 1000), now - 2000)], ME, now)
                .is_none()
        );
    }

    /// A partial run says so, because the partial form is the one everybody on
    /// this machine actually types and "cargo-check is red" would otherwise be
    /// claiming more than was run.
    #[test]
    fn a_partial_run_does_not_claim_the_whole_gate() {
        let now = 1_000_000;
        let mut r = gate_run(OTHER, "cargo-check", "failed", Some(now - 1000), now - 2000);
        r.scope = "partial".into();
        r.narrowed = Some("no test modules".into());
        let out = standing_gates(&[r], ME, now).unwrap();
        assert!(out.contains("only no test modules"), "{out}");
        assert!(out.contains("may not be the whole gate"), "{out}");
    }

    /// The third waste of that afternoon, named directly. The pin was applied
    /// and lost three times and each card assumed a sibling had undone it; all
    /// three were losing to cargo re-resolving a lock entry.
    #[test]
    fn a_flapping_gate_says_so_and_names_the_reason_it_usually_is() {
        let now = 1_000_000;
        let runs = vec![
            gate_run(OTHER, "cargo-check", "failed", Some(now - 10_000), now - 11_000),
            gate_run(OTHER, "cargo-check", "passed", Some(now - 20_000), now - 21_000),
            gate_run(OTHER, "cargo-check", "failed", Some(now - 30_000), now - 31_000),
            gate_run(OTHER, "cargo-check", "passed", Some(now - 40_000), now - 41_000),
        ];
        let out = standing_gates(&runs, ME, now).unwrap();
        assert!(out.contains("green and red"), "{out}");
        assert!(out.contains("--precise"), "{out}");
    }

    /// One breakage, one green-again, is news rather than flapping — and calling
    /// it flapping would cry wolf on the commonest thing that happens to a gate.
    #[test]
    fn one_change_is_not_flapping() {
        let now = 1_000_000;
        let runs = vec![
            gate_run(OTHER, "test", "failed", Some(now - 10_000), now - 11_000),
            gate_run(OTHER, "test", "passed", Some(now - 20_000), now - 21_000),
        ];
        let out = standing_gates(&runs, ME, now).unwrap();
        assert!(!out.contains("green and red"), "{out}");
    }

    /// **The reading must not read as a claim about the tree right now**, which
    /// is the failure the retracted broadcast was.
    ///
    /// It used to end by forbidding `git stash` too, and no longer does: the
    /// deny in `perilous_reason` refuses that call outright, so a third statement
    /// of one rule on every prompt while a gate was red bought nothing and spent
    /// the emphasis (sink `4dabbb75`). Asserted in the negative, because the
    /// sentence reads as obviously worth having and would otherwise come back.
    #[test]
    fn the_reading_states_its_own_limits_and_leaves_the_deny_to_the_deny() {
        let now = 1_000_000;
        let out = standing_gates(
            &[gate_run(OTHER, "cargo-check", "failed", Some(now - 1000), now - 2000)],
            ME,
            now,
        )
        .unwrap();
        assert!(out.contains("not a claim about the tree right now"), "{out}");
        assert!(out.contains("has not been proved green"), "{out}");
        assert!(!out.contains("git stash"), "the stash rule is stated twice already: {out}");
        assert!(out.starts_with("<volery-gate-health>"), "{out}");
        assert!(out.ends_with("</volery-gate-health>"), "{out}");
    }

    /// A card that has closed is the commonest reason a name is missing, and it
    /// is exactly when the observation matters most and there is nobody to ask.
    #[test]
    fn an_observation_outlives_the_card_that_made_it() {
        let now = 1_000_000;
        let mut r = gate_run(OTHER, "test", "failed", Some(now - 1000), now - 2000);
        r.card_name = None;
        let out = standing_gates(&[r.clone()], ME, now).unwrap();
        assert!(out.contains("card bbbbbbbb"), "{out}");

        /* And a card still carrying its draft name is not introduced as
           "untitled", which reads as a fault rather than as a card. */
        r.card_name = Some("untitled".into());
        assert!(standing_gates(&[r], ME, now).unwrap().contains("card bbbbbbbb"));
    }

    /// Two broken gates are two lines, not one merged claim.
    #[test]
    fn each_gate_speaks_for_itself() {
        let now = 1_000_000;
        let runs = vec![
            gate_run(OTHER, "cargo-check", "failed", Some(now - 1000), now - 2000),
            gate_run(OTHER, "test", "failed", Some(now - 3000), now - 4000),
        ];
        let out = standing_gates(&runs, ME, now).unwrap();
        assert!(out.contains("cargo-check was RED"), "{out}");
        assert!(out.contains("test was RED"), "{out}");
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
            serde_json::from_str(&settings(false, Some(("abc123", dir)), false)).unwrap();
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

    fn verb(command: &str) -> Option<String> {
        tree_wide(command).map(|t| t.verb)
    }

    /// The command that started all this, in the forms it actually gets typed.
    #[test]
    fn a_stash_is_caught_however_it_is_spelled() {
        for command in [
            "git stash",
            "git stash push",
            "git stash -u",
            "git stash --include-untracked",
            "git stash pop",
            "git stash apply",
            "git stash drop",
            "git stash clear",
            "cd /c/repo && git stash",
            "git status && git stash && cargo check",
            "env FOO=1 git stash",
            "/usr/bin/git stash",
        ] {
            assert_eq!(verb(command).as_deref(), Some("stash"), "missed: {command}");
        }
    }

    /// `pop` and `drop` are on that list for a reason worth keeping separate
    /// from the rest: they are how a *recovery* goes wrong. `pop` dumps a stash
    /// holding several cards' work into a tree that has moved on since, and
    /// `drop`/`clear` destroy the only copy of it. The morning this guard came
    /// from, the stash was the sole surviving copy of nine files.
    #[test]
    fn reading_a_stash_is_always_allowed() {
        assert_eq!(verb("git stash list"), None);
        assert_eq!(verb("git stash show"), None);
        assert_eq!(verb("git stash show -p stash@{0}"), None);
    }

    /// The recovery procedure itself. Denying any of these would be denying the
    /// way out, which is the property that makes refusing safe at all.
    #[test]
    fn the_pathspec_forms_are_the_way_out_and_stay_open() {
        for command in [
            "git checkout stash@{0} -- src/lib/a.ts",
            "git checkout HEAD -- src/lib/a.ts src/lib/b.ts",
            "git reset -q -- src/lib/a.ts",
            "git restore -- src/lib/a.ts",
            "git diff stash@{0} -- src/lib/a.ts",
            "git stash list",
        ] {
            assert_eq!(verb(command), None, "wrongly denied: {command}");
        }
    }

    /// A whole-tree target wearing the shape of a pathspec. `git checkout -- .`
    /// has a `--` and is exactly the thing being guarded against.
    #[test]
    fn a_dot_after_the_dashes_is_still_the_whole_tree() {
        assert_eq!(verb("git checkout -- ."), Some("checkout".into()));
        assert_eq!(verb("git checkout -- ./"), Some("checkout".into()));
        assert_eq!(verb("git restore -- :/"), Some("restore".into()));
        assert_eq!(verb("git checkout ."), Some("checkout".into()));
        assert_eq!(verb("git reset --hard"), Some("reset".into()));
        assert_eq!(verb("git reset --hard HEAD~1"), Some("reset".into()));
        assert_eq!(verb("git clean -fd"), Some("clean".into()));
        assert_eq!(verb("git clean -n"), Some("clean".into()));
    }

    /// Git refuses all of these against a dirty tree by itself, so none of them
    /// silently destroys uncommitted work — and denying them would stop real
    /// work for nothing. If this test is ever changed, the argument on
    /// `tree_wide` has to be changed with it.
    #[test]
    fn the_commands_git_already_guards_are_left_alone() {
        for command in [
            "git rebase origin/main",
            "git merge feat/x",
            "git pull",
            "git switch main",
            "git commit -- a.rs",
            "git add -A",
            "git log --oneline",
            "git status --short",
            "git worktree add ../tree -b feat/x",
        ] {
            assert_eq!(verb(command), None, "wrongly denied: {command}");
        }
    }

    /// The same quoting rules the commit guard needs, for the same reason: a
    /// commit message that talks about `git stash` is prose, not a command.
    #[test]
    fn a_stash_inside_a_quote_or_a_heredoc_is_not_a_command() {
        assert_eq!(verb("echo \"git stash\""), None);
        assert_eq!(verb("echo 'git stash'"), None);
        let command = "git commit -F - -- a.rs <<'EOF'\n\
                       skein: never run git stash in a shared tree\n\
                       EOF";
        assert_eq!(verb(command), None);
    }

    /// `-C` comes back for the reason it does on a commit: it names the tree
    /// that would actually be harmed, and `perilous` refuses to judge one that
    /// is not the card's own.
    #[test]
    fn the_dash_c_directory_comes_back_for_a_discard() {
        assert_eq!(
            tree_wide("git -C ../nova stash").unwrap().dir.as_deref(),
            Some("../nova")
        );
        assert_eq!(tree_wide("git stash").unwrap().dir, None);
    }

    /// The refusal has to carry its reasoning and a runnable way forward —
    /// `sweep_reason`'s contract, and what makes denying safe rather than
    /// obstructive.
    #[test]
    fn the_refusal_names_the_cards_and_the_way_out() {
        let siblings = vec![
            crate::store::Sibling {
                conversation_id: "0f1a7eee-1111-2222-3333-444455556666".into(),
                title: "two verbs".into(),
            },
            crate::store::Sibling {
                conversation_id: "c2304bef-1111-2222-3333-444455556666".into(),
                title: String::new(),
            },
        ];
        let msg = perilous_reason(&tree_wide("git stash").unwrap(), &siblings);
        assert!(msg.contains("git stash"), "does not name the command: {msg}");
        assert!(msg.contains("two verbs (0f1a7eee)"), "does not name the card: {msg}");
        assert!(msg.contains("card c2304be"), "an untitled card is still named: {msg}");
        assert!(msg.contains("git checkout <ref> -- <one file>"), "no way out: {msg}");
        assert!(msg.contains("worktree"), "does not offer a clean tree: {msg}");
        assert!(msg.contains("ask the user"), "does not route to the user: {msg}");
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
