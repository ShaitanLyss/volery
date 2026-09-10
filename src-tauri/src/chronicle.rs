/*! The chronicle: what happened on this wall, and the wisp that says so.
 *
 * One record read two ways. A **wisp** is an entry in its first few seconds,
 * drawn at the edge of the card that wrote it, in wall space — so where it came
 * from is its position rather than a label. It drifts to the register and
 * settles into it as a row, and the row is the same object. Nothing here appears
 * and then vanishes, which is why there is no dismissal gesture: things scroll
 * off, they are not dismissed. `.claude/rules/chronicle.md` is the whole of the
 * design; `chronicle.ts` is the reading; `store.rs`'s chronicle block is the
 * table.
 *
 * This file is the two MCP tools and the one function Volery uses to write its
 * own entries. What is *interesting* here, and what the tests below are about:
 *
 * ### A card may not write `ask`
 *
 * `CARD_LEVELS` is three of the store's four. Amber on this wall means a
 * structured ask is waiting — `attention.rs`'s ladder is built on it, and
 * `attention.svelte.ts`'s head comment argues against there ever being a second
 * answer to "how does Volery get your attention". So the wall may write "this
 * card is asking you"; a card may not claim your attention through this channel.
 * It already has `ask_user`, which is the honest way to want somebody and costs
 * the card its own turn to use.
 *
 * A card that passes `level: "ask"` is not refused — it is filed as `note` and
 * *told*, in the tool result, that the level was not available to it and why.
 * Refusing would lose the entry, which is the one failure this feature cannot
 * have; saying nothing would teach the card that `ask` works.
 *
 * ### Nothing here escalates
 *
 * No level reaches the taskbar, the peek window or the chime. The away-ladder
 * stays Volery's own judgement about cards that are blocked, failed or overdue.
 * Chosen for reversibility as much as taste: adding escalation later is one
 * optional field and one branch, and removing it later means breaking a contract
 * cards have already been taught.
 *
 * ### `source` is resolved here and stored
 *
 * Not joined on read. A card gets closed and a project gets forgotten, and the
 * row has to go on saying who spoke — see `migrate_v32`. `from_id` is
 * provenance only.
 *
 * ### The trim is a correctness property
 *
 * `store::trim_chronicle` deletes **seen rows first**. A plain newest-N cap
 * would delete the oldest *unseen* rows on a wall left running over a weekend —
 * exactly the ones nobody has read, and the only ones whose loss cannot be
 * recovered from. The note is there rather than here because that is where the
 * SQL is, but it is the reason this feature is worth anything after an absence.
 */

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::store::Store;

pub const WISP_TOOL: &str = "wisp";
pub const CHRONICLE_TOOL: &str = "chronicle";

/// The three a card may write. See the module note — this is the escalation
/// decision, and it is a constant rather than a check at a call site so that
/// nothing has to remember the rule.
const CARD_LEVELS: [&str; 3] = ["note", "good", "bad"];

/// The level a card gets when it asks for one it may not have, or for one this
/// build does not know.
const FALLBACK_LEVEL: &str = "note";

/// What the wall can draw of a mark and a detail.
///
/// A wisp is drawn *large*, on the wall, for a moment — so a mark is a headline
/// and not a paragraph, and something has to say so before the wall is asked to
/// paint a rectangle the size of a territory. Trimmed here, where the card can
/// be told it happened, and again in `chronicle.ts::normalize` as a backstop for
/// any row that got into the table another way.
///
/// This is deliberately *unlike* `sink`'s body, which has no cap: a sink item is
/// an archive read by whoever picks it up in a month, and clipping it threw away
/// the half the author believed they had filed (sink `7b26058e`). A wisp is the
/// opposite kind of object — a line, read at a glance, with the long version
/// belonging in the sink or in the card's own transcript.
const MARK_MAX: usize = 120;
const DETAIL_MAX: usize = 240;

/// Same bound `sink` puts on globs, for the same reason: a list this long is not
/// "which files" any more.
const MAX_GLOBS: usize = 8;

/// How many rows a card is given when it reads. Small on purpose — an agent
/// reading the chronicle wants to know what has been going on, not to page
/// through two thousand rows inside its own context budget.
const CARD_PAGE: i64 = 40;

#[derive(Clone, Serialize)]
struct ChronicleChanged {
    project_id: Option<String>,
}

/// Every write emits, so the register is a fold over events that arrive rather
/// than something that polls — the pipeline rule in CLAUDE.md. `project_id`
/// rides along for `sink:changed`'s economy: a face showing one territory can
/// ignore an event about another without a read.
fn changed(app: &AppHandle, project_id: Option<String>) {
    let _ = app.emit("chronicle:changed", ChronicleChanged { project_id });
}

/* ── writing ─────────────────────────────────────────────────────────────────*/

/// Volery's own way in.
///
/// The wall writes through this and cards write through `do_wisp`; both land in
/// one table, and this is the *only* caller that may pass `ask`. Errors are
/// swallowed deliberately: every call site is something else's success path — a
/// turn ending, a gate going red — and a chronicle that could fail a gate run by
/// failing to record it would be worse than one with a gap.
pub fn note(
    app: &AppHandle,
    project_id: Option<&str>,
    source: &str,
    level: &str,
    mark: &str,
    detail: &str,
) {
    let mark = crate::clip::keep(mark.trim(), MARK_MAX).kept;
    if mark.is_empty() {
        return;
    }
    let detail = crate::clip::keep(detail.trim(), DETAIL_MAX).kept;
    let store = app.state::<Store>();
    let wrote = store.0.lock().ok().and_then(|conn| {
        crate::store::add_chronicle_entry(
            &conn, None, project_id, source, level, &mark, &detail, "",
        )
        .ok()
    });
    if wrote.is_some() {
        changed(app, project_id.map(str::to_string));
    }
}

fn globs_from(v: Option<&Value>) -> String {
    let mut out: Vec<String> = Vec::new();
    match v {
        Some(Value::String(s)) => out.push(s.trim().to_string()),
        Some(Value::Array(a)) => {
            for it in a {
                if let Some(s) = it.as_str() {
                    let s = s.trim();
                    if !s.is_empty() {
                        out.push(s.to_string());
                    }
                }
            }
        }
        _ => {}
    }
    out.retain(|s| !s.is_empty());
    out.truncate(MAX_GLOBS);
    out.join("\n")
}

/// What a card is called in the register.
///
/// The project and the card's own name, which is `naming.ts::nameBesideProject`
/// one layer down — an untitled card prints its project alone, since that is the
/// more useful of the two facts and "untitled" is not a name.
fn source_of(app: &AppHandle, caller: &str) -> (Option<String>, String) {
    let store = app.state::<Store>();
    let row = store
        .0
        .lock()
        .ok()
        .and_then(|conn| crate::store::roster_one(&conn, caller));
    match row {
        Some(r) if r.title.trim().is_empty() => (Some(r.project_id), r.project),
        Some(r) => {
            let name = format!("{} · {}", r.project, r.title.trim());
            (Some(r.project_id), crate::clip::keep(&name, 80).kept)
        }
        /* A card the roster does not know is one being closed as it wrote, or a
           control-surface caller. The entry is still worth keeping — losing it
           would be losing the one class of event most likely to explain
           something — so it is filed at wall scope under its handle. */
        None => (None, format!("card {caller}")),
    }
}

fn do_wisp(app: &AppHandle, caller: &str, args: &Value) -> String {
    let Some(mark) = args.get("mark").and_then(Value::as_str) else {
        return "no `mark` was given, so nothing was written to the chronicle".into();
    };
    let mark_cut = crate::clip::keep(mark.trim(), MARK_MAX);
    let mark = mark_cut.kept.clone();
    if mark.is_empty() {
        return "the mark was empty, so nothing was written to the chronicle".into();
    }
    let detail_cut = crate::clip::keep(
        args.get("detail").and_then(Value::as_str).unwrap_or("").trim(),
        DETAIL_MAX,
    );
    let detail = detail_cut.kept.clone();

    let asked = args
        .get("level")
        .and_then(Value::as_str)
        .map(str::to_lowercase)
        .unwrap_or_else(|| FALLBACK_LEVEL.to_string());
    let level = if CARD_LEVELS.contains(&asked.as_str()) {
        asked.clone()
    } else {
        FALLBACK_LEVEL.to_string()
    };
    let paths = globs_from(args.get("paths"));
    let (project_id, source) = source_of(app, caller);

    let store = app.state::<Store>();
    let Ok(conn) = store.0.lock() else {
        return "the store is unavailable, so nothing was written to the chronicle".into();
    };
    if let Err(e) = crate::store::add_chronicle_entry(
        &conn,
        Some(caller),
        project_id.as_deref(),
        &source,
        &level,
        &mark,
        &detail,
        &paths,
    ) {
        return format!("could not write to the chronicle: {e}");
    }
    drop(conn);
    changed(app, project_id);

    /* Everything the card should know about what was actually filed, and nothing
       it should not. The two cases worth a sentence are a level it could not
       have and a line that was trimmed — both are the card's own text coming
       back different from how it was sent, which is the one thing a tool result
       owes its caller. */
    let mut said = format!("on the wall as `{level}` — {mark}");
    if asked != level {
        said.push_str(&format!(
            "\n\nnote: `{asked}` is not a level a card may write, so this was filed as \
             `{level}`. The levels here are `note`, `good` and `bad` — a record of what \
             happened. `ask` is the wall's own, because amber on this wall means a \
             structured ask is waiting and the way to actually want the user is \
             `ask_user`, which costs you a turn and is meant to."
        ));
    }
    if mark_cut.omitted > 0 || detail_cut.omitted > 0 {
        said.push_str(
            "\n\nnote: this was trimmed to fit. A wisp is drawn large on the wall for a \
             moment and then read as one line — keep the mark to a headline and put the \
             long version where it will be looked for, in the sink or in your own \
             transcript.",
        );
    }
    said
}

/* ── reading ─────────────────────────────────────────────────────────────────*/

fn do_chronicle(app: &AppHandle, caller: &str, args: &Value) -> String {
    let wall = args.get("scope").and_then(Value::as_str) == Some("skein");
    let (mine, _) = source_of(app, caller);
    let scope = if wall { None } else { mine.as_deref() };

    let store = app.state::<Store>();
    let Ok(conn) = store.0.lock() else {
        return "the store is unavailable".into();
    };
    let rows = match crate::store::chronicle_entries(&conn, scope, CARD_PAGE) {
        Ok(r) => r,
        Err(e) => return format!("could not read the chronicle: {e}"),
    };
    let unseen = crate::store::chronicle_unseen(&conn);
    drop(conn);

    if rows.is_empty() {
        return "the chronicle is empty — nothing has been recorded on this wall yet.".into();
    }

    let now = crate::store::now();
    let mut out = String::new();
    for r in &rows {
        out.push_str(&format!(
            "[{}] {} — {}{}\n",
            r.level,
            r.source,
            r.mark,
            if r.detail.is_empty() {
                String::new()
            } else {
                format!(" ({})", r.detail)
            }
        ));
        out.push_str(&format!("    {}\n", crate::relay::ago(now - r.at)));
    }
    out.push_str(&format!(
        "\n{} shown, {unseen} of them not yet read by the user.",
        rows.len()
    ));
    out
}

pub fn handle(app: &AppHandle, conversation_id: &str, tool: &str, args: &Value) -> Option<String> {
    match tool {
        WISP_TOOL => Some(do_wisp(app, conversation_id, args)),
        CHRONICLE_TOOL => Some(do_chronicle(app, conversation_id, args)),
        _ => None,
    }
}

/* ── the schemas ─────────────────────────────────────────────────────────────*/

/// **Loaded, and it cost a byte of somebody else's budget to be.**
///
/// `ask::roster`'s own framing of the question is "does a card have to know this
/// exists without being told?", and for `wisp` the answer is yes on exactly the
/// argument that loads `pin` and `wake_me`: it exists to replace something an
/// agent does wrongly **by default**. The default is finishing a long piece of
/// work silently, so a wall of ten cards is ten transcripts to open one at a
/// time. Nothing in a prompt tells a card that a wall-level record exists, so
/// nothing makes it look — and a deferred tool is only found by an agent that
/// thought to search for one, which "should I announce this?" is not a question
/// agents ask spontaneously.
///
/// Measured with `bun tools/lift-roster.ts` rather than guessed:
///
///   loaded tier without this          21,924 bytes
///   the budget as it stood            24,000
///   this schema, first draft           3,146  → 25,070, red
///   cut to the sentences `ask::roster`
///   calls "not a cost to be
///   economised on"                     2,077  → 24,001, red **by one byte**
///
/// So the budget went to 25,000 instead, which is a decision recorded on
/// `the_loaded_tier_is_what_every_turn_pays_for` and was the user's to make.
/// Two things about that are worth keeping:
///
/// - **It was not shaved.** A tier tuned to 23,999 is a build one word from red
///   forever, and the words left are the ones that make loading it worth
///   anything — the sentence saying when *not* to write a wisp is what stops
///   this becoming thirty rows of narration on somebody's wall.
/// - **It was not deferred.** The feature is *cards writing to the wall's
///   record*; deferring the write tool ships the feature with its point removed.
///
/// The price was quoted before it was agreed: ~520 tokens on every spawn and
/// every wake, permanently. If this ever moves down a tier, `paths` can come off
/// with it — it is the field that came off first when the tier was the
/// constraint, and it went back once it stopped being.
pub fn wisp_schema() -> Value {
    json!({
        "name": WISP_TOOL,
        "description":
            "Put one line on the wall's chronicle, so the user knows what happened in this \
             card without opening it. It becomes a permanent row.\n\n\
             **Write one when you finish something, or when something goes wrong.** The user \
             runs many cards at once and cannot watch them all, so a card that does good work \
             and says nothing is work they only find by going and looking.\n\n\
             **It is a record, not a way to get attention** — nothing here flashes, chimes or \
             raises a window, at any level. If you need a decision before you can continue, \
             use `ask_user`, which is honest about costing you a turn.\n\n\
             One headline per unit of work, never per tool call — thirty of these is noise. The long version belongs in `drop`, where it will be looked for.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "mark": {
                    "type": "string",
                    "description":
                        "What happened, in one past-tense line — 'pushed 4 commits to main'. \
                         Name the thing, not the step you were on."
                },
                "detail": {
                    "type": "string",
                    "description": "Optional. One more line under it — a count, a file, the reason."
                },
                "level": {
                    "type": "string",
                    "enum": ["note", "good", "bad"],
                    "description": "`good` worked, `bad` did not, `note` (the default) anything else."
                },
                "paths": {
                    "anyOf": [{ "type": "string" }, { "items": { "type": "string" }, "type": "array" }],
                    "description": "Optional. Files this is about."
                }
            },
            "required": ["mark"]
        }
    })
}

/// Deferred, with a hint. Unlike `wisp` this replaces no reflex: a card either
/// wants to know what the rest of the wall has been doing or it does not, and it
/// knows which from the prompt it was given. `every_deferred_tool_can_be_found`
/// is why the hint in `ask::roster` is not optional.
pub fn chronicle_schema() -> Value {
    json!({
        "name": CHRONICLE_TOOL,
        "description":
            "Read the wall's chronicle — the last few dozen things that happened here, newest \
             first, across every card. What each card announced with `wisp`, plus what Volery \
             itself recorded: turns that ended badly, gate runs, the allowance running down.\n\n\
             Use it to catch up before starting something, or to find out whether the thing you \
             are about to report has already been reported by somebody else. It costs no other \
             card a turn — this is a table, not a message.\n\n\
             It is **not** a substitute for the billboard: the board says what work is *in \
             flight* and who is holding which files, and that is what to read before editing a \
             shared tree. This says what has already happened.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "scope": {
                    "type": "string",
                    "enum": ["project", "skein"],
                    "description":
                        "`project` (the default) is this territory's entries plus the wall-wide \
                         ones. `skein` is every card on the wall, across every project."
                }
            }
        }
    })
}

/* ── the wall's way in ───────────────────────────────────────────────────────*/

fn as_json(e: &crate::store::ChronicleEntry) -> Value {
    json!({
        "id": e.id,
        "from": e.from_id,
        "projectId": e.project_id,
        "source": e.source,
        "level": e.level,
        "mark": e.mark,
        "detail": e.detail,
        "paths": e.paths.lines().filter(|l| !l.trim().is_empty()).collect::<Vec<_>>(),
        "at": e.at,
        "seenAt": e.seen_at,
    })
}

#[tauri::command]
pub fn read_chronicle(app: AppHandle, project_id: Option<String>) -> Result<Value, String> {
    let store = app.state::<Store>();
    let conn = store.0.lock().map_err(|_| "the store is unavailable")?;
    let rows = crate::store::chronicle_entries(
        &conn,
        project_id.as_deref(),
        crate::store::CHRONICLE_KEEP,
    )?;
    Ok(json!(rows.iter().map(as_json).collect::<Vec<_>>()))
}

/// Volery's own way in, from the webview.
///
/// The one caller that may pass any level, `ask` included — see the module note
/// on why a *card* may not. That asymmetry is safe here for a structural reason
/// rather than a checked one: cards reach this process through MCP `tools/call`,
/// which lands in `handle`, and a `#[tauri::command]` is reachable only from
/// Volery's own webview. There is no path from a card to this function.
///
/// The knowledge of *which* transitions are worth a row lives in the front end
/// on purpose. Whether a turn ended in an error or in a question is
/// `classify.ts`'s `endingFor`, and nothing in Rust classifies an ending — the
/// column `record_turn` writes is a value the webview computed and sent. Putting
/// the decision here would mean a second classifier, and the two would disagree
/// about a turn the day one of them was edited.
#[tauri::command]
pub fn chronicle_note(
    app: AppHandle,
    project_id: Option<String>,
    source: String,
    level: String,
    mark: String,
    detail: Option<String>,
) -> Result<(), String> {
    note(
        &app,
        project_id.as_deref(),
        &source,
        &level,
        &mark,
        detail.as_deref().unwrap_or(""),
    );
    Ok(())
}

/// How many are waiting, asked on its own.
///
/// Separate from the page rather than counted off it, because the tally on the
/// register's edge has to be right about rows the page did not reach — and
/// because a wall with no register up still wants the number for the header.
#[tauri::command]
pub fn chronicle_waiting(app: AppHandle) -> Result<i64, String> {
    let store = app.state::<Store>();
    let conn = store.0.lock().map_err(|_| "the store is unavailable")?;
    Ok(crate::store::chronicle_unseen(&conn))
}

/// Mark entries seen. An empty list means all of them, which is the "all seen"
/// button; a list is the rows you actually read.
#[tauri::command]
pub fn chronicle_seen(app: AppHandle, ids: Option<Vec<String>>) -> Result<(), String> {
    {
        let store = app.state::<Store>();
        let conn = store.0.lock().map_err(|_| "the store is unavailable")?;
        crate::store::mark_chronicle_seen(&conn, &ids.unwrap_or_default())?;
    }
    changed(&app, None);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The escalation decision, asserted where it would be quietly widened.
    ///
    /// A future edit adding `"ask"` here is the whole of what it would take to
    /// give every card on the wall a way to flash the taskbar, and nothing else
    /// in the tree would say so — the store's column would take it, the front
    /// end would draw it amber, and it would look like a feature.
    #[test]
    fn a_card_may_not_write_the_level_that_means_asking() {
        assert!(!CARD_LEVELS.contains(&"ask"));
        assert_eq!(CARD_LEVELS.len(), 3);
        assert!(CARD_LEVELS.contains(&FALLBACK_LEVEL));
    }

    /// And the fallback may not be the urgent one either. A row inventing an
    /// urgency nobody wrote is worse than a row filed too quietly.
    #[test]
    fn an_unknown_level_falls_somewhere_quiet() {
        assert_eq!(FALLBACK_LEVEL, "note");
    }

    /// The levels a card is *told* about and the levels it may write are two
    /// lists in two languages, and they have drifted in this codebase before —
    /// `sink::KINDS` and `sink.ts::KINDS` are held together by exactly this kind
    /// of assertion for exactly that reason.
    #[test]
    fn the_schema_offers_only_the_levels_a_card_may_write() {
        let s = wisp_schema();
        let offered = s["inputSchema"]["properties"]["level"]["enum"]
            .as_array()
            .expect("the level property has an enum")
            .iter()
            .map(|v| v.as_str().unwrap_or("?").to_string())
            .collect::<Vec<_>>();
        for l in CARD_LEVELS {
            assert!(offered.contains(&l.to_string()), "`{l}` is writable but not offered");
        }
        assert_eq!(offered.len(), CARD_LEVELS.len(), "the enum offers a level nothing accepts");
    }

    /// `wisp` exists to fight a *default*, and the description is the only thing
    /// that can say what the default is. One that merely described the mechanism
    /// would change nobody's behaviour — and that matters more now than it would
    /// have loaded, not less: a deferred tool is reached by an agent that went
    /// looking, so the description is the first and only thing that tells it
    /// when *not* to reach for this.
    #[test]
    fn the_description_says_when_to_write_one_and_when_not_to() {
        let d = wisp_schema()["description"].as_str().unwrap().to_string();
        assert!(d.len() > 600, "too short to replace a habit");
        /* The two halves that make it worth its bytes. */
        assert!(d.contains("when you finish something"));
        assert!(d.contains("ask_user"), "must point at the honest way to want somebody");
        assert!(d.contains("not a way to get attention"));
    }

    /// A read that does not say the board is the other thing is a read an agent
    /// will use *instead* of the board, which is the failure the billboard
    /// exists to prevent.
    #[test]
    fn reading_the_chronicle_does_not_stand_in_for_the_board() {
        let s = chronicle_schema();
        let d = s["description"].as_str().unwrap();
        assert!(d.contains("billboard"));
    }

    #[test]
    fn a_wisp_mark_is_required_and_a_detail_is_not() {
        let s = wisp_schema();
        let req = s["inputSchema"]["required"].as_array().unwrap();
        assert_eq!(req.len(), 1);
        assert_eq!(req[0], json!("mark"));
    }

    #[test]
    fn globs_are_taken_as_one_or_many_and_bounded() {
        assert_eq!(globs_from(Some(&json!("a.ts"))), "a.ts");
        assert_eq!(globs_from(Some(&json!(["a.ts", "b.ts"]))), "a.ts\nb.ts");
        /* The empties are dropped rather than stored as blank lines, since
           `as_json` filters them back out and a round trip must not change the
           count. */
        assert_eq!(globs_from(Some(&json!(["a.ts", "", "  ", "b.ts"]))), "a.ts\nb.ts");
        assert_eq!(globs_from(None), "");
        assert_eq!(globs_from(Some(&json!(7))), "");
        let many: Vec<String> = (0..20).map(|i| format!("f{i}.ts")).collect();
        assert_eq!(globs_from(Some(&json!(many))).lines().count(), MAX_GLOBS);
    }

    /// A mark is a headline and the cap has to be small enough to mean it, while
    /// still fitting the sentences the description asks for by example.
    #[test]
    fn the_caps_fit_the_lines_the_description_asks_for() {
        assert!(MARK_MAX >= "the DXF parser chokes on hatch entities".len());
        assert!(MARK_MAX < 200, "a mark this long is a paragraph on the wall");
        assert!(DETAIL_MAX > MARK_MAX);
    }
}
