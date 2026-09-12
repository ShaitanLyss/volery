//! The pure half of a repair: what counts as unsendable, and what to put in
//! its place.
//!
//! Split from the file handling next door so it can be exercised without a
//! home directory or an `AppHandle`. That is not tidiness — on a machine with
//! no MSVC toolchain `cargo test` cannot run at all (`.claude/rules/build.md`,
//! the `0xC0000139` note), and a scratch crate that includes just this file is
//! the only way the assertions below get run there.

use std::collections::HashMap;

use serde::Serialize;
use serde_json::Value;

/// A U+FFFD or two is somebody *discussing* one; a screenful is binary.
///
/// The replacement character is legal in prose and this repair rewrites another
/// program's file, so the benefit of the doubt goes to leaving text alone. NUL
/// gets no such latitude — see `contaminated`.
const FFFD_TOLERANCE: usize = 3;

/// What a repair took out, for the card to say and the note to name.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct RepairReport {
    /// Records that carried contamination.
    pub records: usize,
    /// Characters removed from the conversation.
    pub chars_removed: usize,
    /// NUL and other C0 control characters found.
    pub nuls: usize,
    /// Characters the CLI had already stood in for, because they would not
    /// decode as UTF-8 when it captured them.
    pub undecodable: usize,
    /// The tool calls whose output carried it, and the file each names. Said
    /// in the note so the agent can decide whether to run one again
    /// differently — and, where a path came out of it, so it knows what to
    /// stop reading.
    pub culprits: Vec<Culprit>,
    /// Where the untouched original is, until the conversation has moved on.
    pub backup: String,
}

/// One tool call that put unsendable characters into the conversation, and what
/// can be said about where they came from.
///
/// The `path` is the whole reason this is a struct rather than the string it
/// replaced. A `400 … unexpected end of data` names a column offset in a
/// serialised request body and nothing else, so the card it kills cannot map it
/// to anything on disk — and since the repair mends the *conversation* and
/// leaves the file exactly as it found it, the next turn reads the same file
/// and dies the same way. Two cards burned five turns on that loop on
/// 2026-09-11 (sink `08de8ed3`), and one never recovered. Naming the file is
/// what makes the repair something an agent can learn from.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct Culprit {
    /// The tool — `Bash`, `Read`, `Grep`.
    pub tool: String,
    /// What it was asked to do, short enough to say on a card.
    pub command: String,
    /// The file this call names, where one could be had.
    pub path: Option<String>,
    /// Whether `path` is what the tool was *handed* or what was read out of a
    /// shell line.
    ///
    /// Two tiers rather than one because a notice that names the wrong file is
    /// worse than a notice that names none: it sends the next card to clean
    /// something that was never dirty. `Read`'s `file_path` is the file it
    /// read, full stop. A path picked out of `cat foo && sed -n 3p bar` is a
    /// good guess and is said as one.
    pub declared: bool,
}

/// NULs and C0 controls, then already-replaced undecodable characters.
///
/// Tab, newline and carriage return are ordinary text and are not counted —
/// every tool result on the wall is full of them.
fn bad_counts(s: &str) -> (usize, usize) {
    let mut control = 0usize;
    let mut undecodable = 0usize;
    for c in s.chars() {
        let n = c as u32;
        if c == '\u{FFFD}' {
            undecodable += 1;
        } else if n == 0x7f || (n < 0x20 && c != '\t' && c != '\n' && c != '\r') {
            control += 1;
        }
    }
    (control, undecodable)
}

/// Is this string carrying something that cannot be sent?
///
/// One control character is enough, because there is no honest way for a NUL to
/// be in a conversation — nothing types one and nothing means one. Undecodable
/// characters need `FFFD_TOLERANCE` of them, since unlike NUL they have a
/// legitimate use: a message about encodings may well contain one.
fn contaminated(s: &str) -> bool {
    let (control, undecodable) = bad_counts(s);
    control > 0 || undecodable >= FFFD_TOLERANCE
}

/// The same string with the unsendable characters gone.
///
/// Used for the conversation's *prose* — an assistant message, a prompt —
/// where the text is the thing worth keeping and the stray character is not.
/// Tool results are handled the other way round; see `note_for`.
fn stripped(s: &str) -> String {
    s.chars()
        .filter(|c| {
            let n = *c as u32;
            !(*c == '\u{FFFD}' || n == 0x7f || (n < 0x20 && *c != '\t' && *c != '\n' && *c != '\r'))
        })
        .collect()
}

/// The arguments a tool hands over that *are* the file it read.
///
/// Only these two. `Grep` and `Glob` take a `path`, but it is the directory
/// they searched under rather than the file the bytes were in, and a repair
/// that answered "the poison is in src/" would be naming a tree. The shell
/// lines go through `path_in_command` instead, which says it is guessing.
const DECLARED_PATH_KEYS: [&str; 2] = ["file_path", "notebook_path"];

/// Extensions common enough that a bare `routing.test.ts` is a path rather
/// than a word with a dot in it.
///
/// A separator is the other tell and the better one — anything with a `/` or a
/// `\` in it was written as a path. This list exists for the single-argument
/// case (`cat routing.test.ts` from inside the directory), which is exactly how
/// an agent reads a file it has just been talking about.
const SOURCE_EXTS: [&str; 31] = [
    "ts", "tsx", "js", "jsx", "mjs", "cjs", "rs", "py", "go", "java", "kt", "c", "h", "cc", "cpp",
    "cs", "rb", "php", "svelte", "vue", "json", "jsonl", "md", "txt", "log", "yml", "yaml", "toml",
    "css", "html", "sql",
];

/// Does this word out of a shell line name a file?
///
/// Deliberately strict, because the cost of a false positive is the thing this
/// whole change exists to avoid: a note that points the next card at a file
/// that was never dirty. A glob names many files and therefore none; a URL is
/// not on this disk; a flag is not a path however many dots are in it.
fn looks_like_a_path(tok: &str) -> bool {
    if tok.is_empty() || tok.starts_with('-') || tok.contains("://") {
        return false;
    }
    /* A glob is a set, and the one thing this must not do is name a file it
       cannot point at. */
    if tok.contains('*') || tok.contains('?') || tok.contains('[') {
        return false;
    }
    if tok.contains('/') || tok.contains('\\') {
        return true;
    }
    let Some((stem, ext)) = tok.rsplit_once('.') else {
        return false;
    };
    !stem.is_empty() && SOURCE_EXTS.contains(&ext.to_ascii_lowercase().as_str())
}

/// The file a shell line reads, as far as a shell line can be read.
///
/// A guess, and the caller says so — `Culprit::declared` is false for anything
/// that comes out of here. It is still the useful half in practice: the loop
/// this exists to break was a card running `cat`, `sed` and `git diff` over one
/// poisoned test file, and every one of those spells the path out.
///
/// The first token is skipped because it is the program, and a redirection
/// target is skipped because it is where output was going rather than where the
/// bytes came from.
fn path_in_command(cmd: &str) -> Option<String> {
    let mut prev = "";
    for (i, raw) in cmd.split_whitespace().enumerate() {
        let tok = raw.trim_matches(|c| c == '"' || c == '\'' || c == ';' || c == ',');
        let redirected = prev == ">" || prev == ">>" || raw.starts_with('>');
        prev = raw;
        if i == 0 || redirected {
            continue;
        }
        if looks_like_a_path(tok) {
            return Some(tok.to_string());
        }
    }
    None
}

/// What stands in the conversation where the tool output used to be.
///
/// Addressed to the agent rather than to the reader, and it is the whole reason
/// this is a repair and not a refusal: an agent that finds its `grep` output
/// silently missing will run it again the same way. One that reads why will
/// not.
///
/// **The second paragraph is the one that breaks the loop**, and it was missing
/// for the first three weeks of this feature. The repair takes the characters
/// out of the *conversation* and does not go near the file, which is correct —
/// rewriting another program's transcript is already the most invasive thing
/// here and rewriting somebody's source on top of it would be worse — but a
/// note that does not say so leaves the agent with a healed turn, an armed
/// landmine and no way to connect the two. So it says which file, that the file
/// still has the bytes, and how to check. The detector is quoted from sink
/// `08de8ed3` verbatim on purpose: it contains no escape sequence, so nothing
/// between here and a shell can mangle it.
fn note_for(
    chars: usize,
    nuls: usize,
    undecodable: usize,
    culprit: Option<&Culprit>,
) -> String {
    let mut note = format!(
        "[skein removed {chars} characters of binary output from this tool result — \
         {nuls} NUL characters and {undecodable} bytes that would not decode. They made \
         every request in this conversation unsendable, so the API rejected the whole \
         turn rather than this one result."
    );
    if let Some(c) = culprit {
        note.push_str(&format!(" The command was: {}.", c.command));
    }
    match culprit.and_then(|c| c.path.as_deref().map(|p| (c, p))) {
        Some((c, path)) => {
            note.push_str(&format!(
                " The characters came from {path}{}, and skein did NOT touch that file — \
                 this repair mends the conversation only, so reading it again in any way \
                 will break this conversation again. Check it with `od -An -tx1 -v {path} \
                 | tr ' ' '\\n' | grep -c '^00$'` — zero is clean, and note that grep and \
                 ripgrep will call the file clean either way. If it is a text file, take \
                 the bytes out of it before anything reads it again, and tell the other \
                 cards: `mcp__skein__post` is what stops the next one walking into it. If \
                 it is a binary, read it through `strings` or not at all.]",
                if c.declared {
                    ""
                } else {
                    /* Said out loud, because the path was read out of a shell
                       line rather than handed over, and a card that cleans the
                       wrong file on our say-so is a worse outcome than a card
                       that has to look. */
                    " — read out of that command rather than handed to skein, so check it \
                     before you trust it"
                }
            ));
        }
        None => note.push_str(
            " Skein could not tell which file they came from: the tool call names none. \
             Whatever produced them still has them, so re-run it in a way that cannot emit \
             binary — grep without -a, or pipe through `strings` — and check any file it \
             read with `od -An -tx1 -v FILE | tr ' ' '\\n' | grep -c '^00$'`, where zero \
             is clean.]",
        ),
    }
    note
}

/// Short form, for the second and later contaminated strings in one result.
const BRIEF_NOTE: &str = "[skein removed further binary output from this tool result.]";

/// Whether a record's own `message.content` is a tool result, and whose.
fn tool_use_id_of(record: &Value) -> Option<String> {
    let content = record.get("message")?.get("content")?.as_array()?;
    for block in content {
        if block.get("type").and_then(Value::as_str) == Some("tool_result") {
            if let Some(id) = block.get("tool_use_id").and_then(Value::as_str) {
                return Some(id.to_string());
            }
        }
    }
    None
}

/// Remember what each `tool_use` asked for, so a later result can name it.
///
/// The command is the useful half — `tool_use` carries `input.command` for
/// Bash, and for everything else the compact input is closer to a description
/// than the tool's name alone would be. The *path* is the half that lets the
/// agent act: see `Culprit`.
fn learn_tool_uses(record: &Value, names: &mut HashMap<String, Culprit>) {
    let Some(content) = record
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
    else {
        return;
    };
    for block in content {
        if block.get("type").and_then(Value::as_str) != Some("tool_use") {
            continue;
        }
        let Some(id) = block.get("id").and_then(Value::as_str) else {
            continue;
        };
        let input = block.get("input");
        let said = input
            .and_then(|i| i.get("command"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| input.map(|i| i.to_string()))
            .unwrap_or_default();
        let name = block
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("a tool");
        let mut summary = if said.is_empty() {
            name.to_string()
        } else {
            format!("{name} {said}")
        };
        /* A command long enough to be worth truncating is long enough that its
           first line is what identifies it. The path is lifted out *before*
           this, and kept in a field of its own, because the file a `git diff`
           or a `grep -rn … <path>` names sits at the end of the line and would
           be the first thing a truncation lost — which is the one piece of it
           worth keeping. */
        if summary.chars().count() > 300 {
            summary = summary.chars().take(300).collect::<String>() + "…";
        }
        let declared = input.and_then(|i| {
            DECLARED_PATH_KEYS
                .iter()
                .find_map(|k| i.get(*k).and_then(Value::as_str))
                .map(str::to_string)
        });
        let guessed = || {
            input
                .and_then(|i| i.get("command"))
                .and_then(Value::as_str)
                .and_then(path_in_command)
        };
        names.insert(
            id.to_string(),
            Culprit {
                tool: name.to_string(),
                command: summary,
                declared: declared.is_some(),
                path: declared.or_else(guessed),
            },
        );
    }
}

/// Replace every contaminated string under `v` with the note. Returns how many
/// it replaced.
fn replace_contaminated(
    v: &mut Value,
    culprit: Option<&Culprit>,
    report: &mut RepairReport,
    replaced_here: &mut usize,
) {
    match v {
        Value::String(s) => {
            if !contaminated(s) {
                return;
            }
            let (nuls, undecodable) = bad_counts(s);
            report.chars_removed += s.chars().count();
            report.nuls += nuls;
            report.undecodable += undecodable;
            *s = if *replaced_here == 0 {
                note_for(s.chars().count(), nuls, undecodable, culprit)
            } else {
                BRIEF_NOTE.to_string()
            };
            *replaced_here += 1;
        }
        Value::Array(items) => {
            for item in items {
                replace_contaminated(item, culprit, report, replaced_here);
            }
        }
        Value::Object(map) => {
            for (_, item) in map.iter_mut() {
                replace_contaminated(item, culprit, report, replaced_here);
            }
        }
        _ => {}
    }
}

/// Take the unsendable characters out of every remaining string, in place.
///
/// This runs after the tool results have been dealt with, and catches the rest:
/// an assistant message that quoted a byte, a prompt pasted out of a terminal.
/// It strips rather than replaces, because prose is worth keeping.
fn strip_everything_else(v: &mut Value, report: &mut RepairReport) -> bool {
    match v {
        Value::String(s) => {
            if !contaminated(s) {
                return false;
            }
            let (nuls, undecodable) = bad_counts(s);
            let clean = stripped(s);
            report.chars_removed += s.chars().count() - clean.chars().count();
            report.nuls += nuls;
            report.undecodable += undecodable;
            *s = clean;
            true
        }
        Value::Array(items) => {
            let mut hit = false;
            for item in items {
                hit |= strip_everything_else(item, report);
            }
            hit
        }
        Value::Object(map) => {
            let mut hit = false;
            for (_, item) in map.iter_mut() {
                hit |= strip_everything_else(item, report);
            }
            hit
        }
        _ => false,
    }
}

/// Repair one record. `None` if there was nothing wrong with it.
///
/// Unparseable lines come back `None` untouched, deliberately: a line this
/// cannot read is a line it must not rewrite, and the file belongs to something
/// else.
fn repair_record(
    line: &str,
    names: &mut HashMap<String, Culprit>,
    report: &mut RepairReport,
) -> Option<String> {
    let mut record: Value = serde_json::from_str(line).ok()?;
    learn_tool_uses(&record, names);

    let culprit = tool_use_id_of(&record).and_then(|id| names.get(&id).cloned());

    let mut replaced_here = 0usize;
    if let Some(content) = record
        .get_mut("message")
        .and_then(|m| m.get_mut("content"))
        .and_then(Value::as_array_mut)
    {
        for block in content {
            if block.get("type").and_then(Value::as_str) == Some("tool_result") {
                replace_contaminated(block, culprit.as_ref(), report, &mut replaced_here);
            }
        }
    }
    /* Claude Code writes the result twice — once as the API block above and
       once as its own richer `toolUseResult` — and a repair that cleaned only
       one of them would leave the conversation exactly as unsendable as it
       found it. */
    if let Some(extra) = record.get_mut("toolUseResult") {
        replace_contaminated(extra, culprit.as_ref(), report, &mut replaced_here);
    }

    let stripped_any = strip_everything_else(&mut record, report);

    if replaced_here == 0 && !stripped_any {
        return None;
    }
    /* Only a *replaced* record gets its call recorded. `strip_everything_else`
       fires on prose — an assistant message that quoted a byte — and the tool
       call it happens to sit beside did not put it there. Naming that call
       would be the wrong-file failure this change exists to prevent, arriving
       through the back door. */
    if replaced_here > 0 {
        if let Some(c) = culprit {
            if !report.culprits.contains(&c) {
                report.culprits.push(c);
            }
        }
    }
    report.records += 1;
    serde_json::to_string(&record).ok()
}

/// Repair a whole transcript in memory. Returns the new text, or `None` when
/// there was nothing to do.
///
/// Separated from the file handling so the interesting half is testable without
/// a home directory — `cargo test` cannot run on a no-MSVC machine, but the
/// assertions are worth having where it can.
pub(crate) fn repair_text(text: &str) -> Option<(String, RepairReport)> {
    let mut names: HashMap<String, Culprit> = HashMap::new();
    let mut report = RepairReport::default();
    let mut out = String::with_capacity(text.len());
    let mut touched = false;

    for line in text.split_inclusive('\n') {
        let (body, eol) = match line.strip_suffix('\n') {
            Some(b) => (b, "\n"),
            None => (line, ""),
        };
        if body.trim().is_empty() {
            out.push_str(line);
            continue;
        }
        match repair_record(body, &mut names, &mut report) {
            Some(fixed) => {
                touched = true;
                out.push_str(&fixed);
                out.push_str(eol);
            }
            None => out.push_str(line),
        }
    }

    touched.then_some((out, report))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shape the real one had: a Bash `tool_use`, then its result carrying
    /// NULs and replacement characters, written twice as the CLI writes it.
    fn poisoned() -> String {
        let junk = "Paste\u{0}\u{0}\u{1c}code\u{FFFD}\u{FFFD}\u{FFFD}here";
        let use_line = serde_json::json!({
            "type": "assistant",
            "message": { "content": [{
                "type": "tool_use",
                "id": "toolu_01AM",
                "name": "Bash",
                "input": { "command": "grep -aoE \"(Paste|paste)\" claude.exe" }
            }]}
        });
        let result_line = serde_json::json!({
            "type": "user",
            "message": { "content": [{
                "type": "tool_result",
                "tool_use_id": "toolu_01AM",
                "content": junk
            }]},
            "toolUseResult": { "stdout": junk, "stderr": "" }
        });
        format!("{use_line}\n{result_line}\n")
    }

    #[test]
    fn a_clean_transcript_is_left_alone() {
        let clean = "{\"type\":\"user\",\"message\":{\"content\":\"hello\"}}\n";
        assert!(repair_text(clean).is_none(), "nothing to repair, so no rewrite");
    }

    #[test]
    fn binary_in_a_tool_result_is_taken_out_and_accounted_for() {
        let (fixed, report) = repair_text(&poisoned()).expect("this one needed repair");
        assert!(!fixed.contains('\u{0}'), "no NUL survives");
        assert!(!fixed.contains('\u{FFFD}'), "no undecodable character survives");
        assert_eq!(report.records, 1, "one record carried it");
        assert_eq!(report.nuls, 6, "three control characters, in both copies");
        assert_eq!(report.undecodable, 6, "three replacement characters, in both copies");
    }

    #[test]
    fn the_note_names_the_command_so_the_agent_can_judge_it() {
        let (fixed, report) = repair_text(&poisoned()).unwrap();
        assert!(
            fixed.contains("grep -aoE"),
            "the note says which command produced it: {fixed}"
        );
        assert!(fixed.contains("skein removed"), "and that skein did the removing");
        assert_eq!(report.culprits.len(), 1);
    }

    /// `grep -aoE … claude.exe` names a binary, not a source file, and this is
    /// the arm that must not invent one. The advice it gives instead — re-run
    /// it differently — is the right advice for exactly this case.
    #[test]
    fn a_call_that_names_no_source_file_says_so_rather_than_guessing() {
        let (fixed, report) = repair_text(&poisoned()).unwrap();
        assert_eq!(report.culprits[0].path, None, "claude.exe is not a source file");
        assert!(
            fixed.contains("could not tell which file"),
            "and the note admits it rather than pointing somewhere: {fixed}"
        );
        assert!(fixed.contains("strings"), "with the advice that does fit this case");
    }

    #[test]
    fn both_copies_of_the_result_are_cleaned() {
        /* The API block and `toolUseResult` are the same output written twice.
           Cleaning one leaves the conversation exactly as unsendable. */
        let (fixed, _) = repair_text(&poisoned()).unwrap();
        let record: Value = fixed.lines().nth(1).map(serde_json::from_str).unwrap().unwrap();
        let extra = record["toolUseResult"]["stdout"].as_str().unwrap();
        assert!(extra.contains("skein removed"), "toolUseResult was cleaned too");
    }

    #[test]
    fn a_line_that_will_not_parse_is_not_rewritten() {
        let broken = "{not json at all\n";
        assert!(repair_text(broken).is_none(), "a line this cannot read, it must not touch");
    }

    #[test]
    fn prose_keeps_its_text_and_loses_only_the_bad_character() {
        let line = serde_json::json!({
            "type": "assistant",
            "message": { "content": [{ "type": "text", "text": "before\u{0}after" }] }
        })
        .to_string();
        let (fixed, _) = repair_text(&format!("{line}\n")).unwrap();
        assert!(
            fixed.contains("beforeafter"),
            "an assistant message is stripped, not replaced: {fixed}"
        );
    }

    #[test]
    fn a_message_mentioning_one_replacement_character_is_not_touched() {
        /* U+FFFD has an honest use and this rewrites somebody else's file, so
           the benefit of the doubt goes to leaving text alone. NUL gets none. */
        let line = serde_json::json!({
            "type": "assistant",
            "message": { "content": [{ "type": "text", "text": "the char is \u{FFFD}, see?" }] }
        })
        .to_string();
        assert!(repair_text(&format!("{line}\n")).is_none());
    }

    /// The loop from sink `08de8ed3`: a card `cat`s a poisoned source file, the
    /// turn dies on a 400 that names a column offset in a request body, the
    /// repair mends the conversation, and the *file* is still poisoned — so the
    /// next turn reads it and dies identically. `cat` is what the filing card
    /// actually ran.
    fn poisoned_file(tool: &str, input: Value) -> String {
        let junk = "export const routes = [\u{0}];";
        let use_line = serde_json::json!({
            "type": "assistant",
            "message": { "content": [{
                "type": "tool_use", "id": "toolu_03FL", "name": tool, "input": input
            }]}
        });
        let result_line = serde_json::json!({
            "type": "user",
            "message": { "content": [{
                "type": "tool_result", "tool_use_id": "toolu_03FL", "content": junk
            }]}
        });
        format!("{use_line}\n{result_line}\n")
    }

    #[test]
    fn the_note_names_the_file_and_says_the_file_was_not_touched() {
        let (fixed, report) = repair_text(&poisoned_file(
            "Read",
            serde_json::json!({ "file_path": "preview-router/lib/routing.test.ts" }),
        ))
        .unwrap();
        assert_eq!(
            report.culprits[0].path.as_deref(),
            Some("preview-router/lib/routing.test.ts")
        );
        assert!(report.culprits[0].declared, "a file_path is handed over, not guessed");
        assert!(
            fixed.contains("preview-router/lib/routing.test.ts"),
            "the note names the file: {fixed}"
        );
        /* The half that breaks the loop. Without it the agent has a healed turn
           and an armed landmine, with nothing connecting the two. */
        assert!(
            fixed.contains("did NOT touch that file"),
            "and says the file still has them: {fixed}"
        );
        assert!(fixed.contains("od -An -tx1 -v"), "and how to check: {fixed}");
    }

    #[test]
    fn a_path_read_out_of_a_shell_line_is_offered_as_a_guess() {
        let (fixed, report) = repair_text(&poisoned_file(
            "Bash",
            serde_json::json!({ "command": "cat preview-router/lib/routing.test.ts" }),
        ))
        .unwrap();
        assert_eq!(
            report.culprits[0].path.as_deref(),
            Some("preview-router/lib/routing.test.ts")
        );
        assert!(!report.culprits[0].declared, "nobody handed this one over");
        /* Named, but hedged. A notice that sends the next card to clean a file
           that was never dirty is worse than one that names nothing. */
        assert!(
            fixed.contains("read out of that command"),
            "the guess is said to be a guess: {fixed}"
        );
    }

    #[test]
    fn the_path_survives_a_command_too_long_to_quote() {
        /* Why the path is a field of its own rather than left inside the
           command summary: the file a real diff or grep names sits at the end
           of the line, which is the first thing a truncation loses. */
        let long = format!("git diff {} -- src/deep/routing.test.ts", "--stat ".repeat(60));
        let (_, report) =
            repair_text(&poisoned_file("Bash", serde_json::json!({ "command": long }))).unwrap();
        assert!(
            !report.culprits[0].command.contains("routing.test.ts"),
            "the summary was truncated past it"
        );
        assert_eq!(
            report.culprits[0].path.as_deref(),
            Some("src/deep/routing.test.ts"),
            "and the path survived anyway"
        );
    }

    #[test]
    fn prose_alone_does_not_accuse_the_tool_call_next_to_it() {
        /* A record whose tool result is clean and whose *other* fields are not
           — a prompt the user pasted, a cwd. `strip_everything_else` fires,
           `replace_contaminated` does not, and the file that call read is
           innocent. Naming it would be the wrong-file failure arriving by the
           back door. */
        let call = serde_json::json!({
            "type": "assistant",
            "message": { "content": [{
                "type": "tool_use", "id": "toolu_04", "name": "Read",
                "input": { "file_path": "innocent.ts" }
            }]}
        });
        let result = serde_json::json!({
            "type": "user",
            "message": { "content": [{
                "type": "tool_result", "tool_use_id": "toolu_04", "content": "all fine here"
            }]},
            "summary": "pasted\u{0}from a terminal"
        });
        let (fixed, report) = repair_text(&format!("{call}\n{result}\n")).unwrap();
        assert!(fixed.contains("pastedfrom a terminal"), "the prose was stripped");
        assert!(report.culprits.is_empty(), "nothing was replaced, so nothing is blamed");
        assert!(!fixed.contains("skein removed"), "and no note accuses anything");
    }

    #[test]
    fn a_shell_line_is_read_for_a_path_without_inventing_one() {
        assert_eq!(path_in_command("cat src/a.ts").as_deref(), Some("src/a.ts"));
        /* From inside the directory, with no separator to go on. */
        assert_eq!(path_in_command("cat routing.test.ts").as_deref(), Some("routing.test.ts"));
        assert_eq!(
            path_in_command("sed -n '193p' lib/routing.test.ts").as_deref(),
            Some("lib/routing.test.ts"),
            "a quoted sed script is not a path"
        );
        /* A glob is a set and therefore names no file; a URL is not on this
           disk; a flag is not a path however many dots are in it. */
        assert_eq!(path_in_command("grep -rn foo src/**/*.ts"), None);
        assert_eq!(path_in_command("curl https://example.com/a.json"), None);
        assert_eq!(path_in_command("node --experimental-strip-types"), None);
        /* The program is not what it read, and neither is where it wrote. */
        assert_eq!(path_in_command("./scripts/build.sh"), None);
        assert_eq!(path_in_command("echo hi > out.log"), None);
        /* A version is not a file, and `git diff` on its own names nothing. */
        assert_eq!(path_in_command("bun x tsc@5.4.2"), None);
        assert_eq!(path_in_command("git diff --stat"), None);
    }
}
