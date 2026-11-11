//! The phone's front desk.
//!
//! Lyss talks to her wall from her phone, and a sentence like "create a
//! simulation in python" is neither a plan nor a question: it starts a
//! conversation, and neither rung the phone has can hold one. The steward turns
//! one utterance into one plan; `provider::answer_question` is one question and
//! one answer with no memory of the next, which is why it could only ever say
//! "ask a card on your wall".
//!
//! So the wall keeps a **card** for the phone to talk to, and everything a
//! conversation needs is already in this codebase. A card remembers. A card can
//! open another card (`spawn`), which is where work that needs a computer
//! happens. And a card's question reaches the phone through the ask queue the
//! phone already reads aloud and answers in its own words (`ask.rs`,
//! `prompts.rs`), so the reply channel is one that has been working for weeks.
//!
//! **What this module owns is which card it is and what to say to it.** The id
//! lives in `flyway_setting` — a key and a value, the table `here.rs` already
//! reads for the fleet — and nothing else about the front desk is stored. The
//! card itself is opened by the window, because `Skein.openSpawned` is the one
//! place that writes a row, settles a preset and delivers a first prompt in the
//! order `#openIn` guarantees; a second birth path in Rust would be a card that
//! could disagree with the wall about what it is. So this emits `voice:say` and
//! the front end either opens the card or sends into the one it already has,
//! waking it if the reaper stood it down.
//!
//! **A stale id heals itself.** The setting is written before the card exists,
//! so a window that dies between the two leaves an id with no row. `find` asks
//! for an *open* card, anything else mints a new id, and the setting is
//! overwritten — the same bargain `#openIn` strikes by recording before it
//! spawns.

use std::path::Path;

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

/// Where this wall keeps the card the phone talks to. A `flyway_setting` row
/// because it is one small thing a person or this module sets, and the next
/// knob of the same kind should be a row rather than a schema rung.
pub const SETTING: &str = "front_desk";

/// The territory the front desk prefers, by folder name. She chose workbench:
/// the front desk should be able to read the projects her work is in.
pub const PREFERRED: &str = "workbench";

/// What the front desk is told it is, as its first prompt.
///
/// **Every sentence here is load-bearing.** The voice is the only channel to a
/// model that cannot ask a follow-up question, and a model that does not know
/// its words arrive through `ask_user` simply answers into the void. That is
/// not hypothetical: a card asked to be a voice interface without this brief
/// writes prose and ends its turn, and the phone hears nothing at all.
pub const BRIEF: &str = "You are the front desk on Lyss's wall, reached from her phone by voice. \
    Whatever you say is read aloud, so write for the ear: short sentences, no markdown, no lists, \
    no code.\n\n\
    The only way your words reach her is the ask_user tool. End every reply with it: put what \
    you want to say in the question, and give options only when you are offering her a choice she \
    can tap. Her answer comes back to you as her next sentence, in her own words.\n\n\
    You can also open a conversation on this wall and send a prompt to a card. Work that needs a \
    computer happens in a card, never in you. When she asks for something to be built, written or \
    run, work out what the card needs to know, ask her only what changes the work, then open a \
    card with the spawn tool and tell her where it is and what you told it.\n\n\
    Ask one question at a time. Never claim to have done anything you have not done.";

/// What the card is called on the wall, so a person can recognise it.
pub const TITLE: &str = "the front desk";

/// Which territory the front desk stands in, given the roots this wall knows.
///
/// A preference rather than a setting: the roots are a fact about the wall, and
/// asking her to type one would be asking her to repeat what the wall can see.
/// `workbench` first because that is where the projects she works in live, and
/// the wall's first root otherwise so a wall without it still gets a front desk
/// rather than an error. Pure, and tested, because "which folder" is the whole
/// of what can go wrong here without anything failing.
pub fn pick_home(roots: &[String]) -> Option<String> {
    let named = |root: &String, want: &str| {
        Path::new(root)
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.eq_ignore_ascii_case(want))
    };
    roots
        .iter()
        .find(|r| named(r, PREFERRED))
        .or_else(|| roots.first())
        .cloned()
}

/// The card the phone talks to, if this wall still has one.
fn find(app: &AppHandle) -> Option<String> {
    let store = app.try_state::<crate::store::Store>()?;
    let conn = store.0.lock().ok()?;
    let id = crate::flyway::here::setting(&conn, SETTING)?;
    let open: bool = conn
        .query_row(
            "SELECT closed_at IS NULL FROM conversation WHERE id = ?1",
            rusqlite::params![id],
            |r| r.get(0),
        )
        .unwrap_or(false);
    open.then_some(id)
}

/// The roots of every project on this wall, in the order they were added.
fn roots(app: &AppHandle) -> Result<Vec<String>, String> {
    let store = app
        .try_state::<crate::store::Store>()
        .ok_or_else(|| "the store is unavailable".to_string())?;
    let conn = store
        .0
        .lock()
        .map_err(|_| "the store is wedged".to_string())?;
    let mut q = conn
        .prepare("SELECT root_path FROM project ORDER BY created_at, name")
        .map_err(|e| e.to_string())?;
    let rows = q
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();
    Ok(rows)
}

/// Say something to the front desk, opening it first if this wall has none.
///
/// Answers the card's id and whether it is being opened now, which is the whole
/// of what the phone needs to draw while it waits: a fresh front desk takes a
/// spawn and a first turn before it can ask anything.
pub fn said(app: &AppHandle, text: &str) -> Result<(String, bool), String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("nothing was said".into());
    }
    if let Some(id) = find(app) {
        let _ = app.emit(
            "voice:say",
            json!({ "id": id, "text": text, "cwd": "", "title": TITLE, "brief": "" }),
        );
        return Ok((id, false));
    }
    /* Not stored yet, so a window that never opens this card leaves nothing
    behind but an id that `find` will refuse next time — see the header. */
    let cwd = pick_home(&roots(app)?).ok_or_else(|| {
        "this wall has no project, so there is nowhere to put a front desk".to_string()
    })?;
    let id = crate::store::uuid_v4();
    {
        let store = app
            .try_state::<crate::store::Store>()
            .ok_or_else(|| "the store is unavailable".to_string())?;
        let conn = store
            .0
            .lock()
            .map_err(|_| "the store is wedged".to_string())?;
        crate::flyway::here::set_setting(&conn, SETTING, &id)?;
    }
    crate::chronicle::note(
        app,
        None,
        "volery",
        "note",
        "the phone's front desk was opened",
        &format!("in {cwd}. the card the phone talks to when a sentence is not a command"),
    );
    app.emit(
        "voice:say",
        json!({ "id": id, "text": text, "cwd": cwd, "title": TITLE, "brief": BRIEF }),
    )
    .map_err(|e| e.to_string())?;
    Ok((id, true))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The brief is the only channel the front desk has for learning how its
    /// words travel, and it fails silently when it is missing: the card answers
    /// in prose, ends its turn, and the phone hears nothing. So the three facts
    /// that make the loop work are held against a rewrite.
    #[test]
    fn the_brief_says_how_its_words_travel() {
        for fact in ["ask_user", "read aloud", "spawn", "Never claim"] {
            assert!(BRIEF.contains(fact), "the front desk's brief lost {fact:?}");
        }
    }

    #[test]
    fn the_front_desk_stands_in_workbench_when_the_wall_has_one() {
        let roots = vec![
            "C:\\atelier\\nova".to_string(),
            "C:\\atelier\\workbench".to_string(),
            "C:\\atelier\\rise".to_string(),
        ];
        assert_eq!(pick_home(&roots).as_deref(), Some("C:\\atelier\\workbench"));
    }

    #[test]
    fn and_in_the_first_root_when_it_does_not() {
        let roots = vec![
            "C:\\atelier\\nova".to_string(),
            "C:\\atelier\\rise".to_string(),
        ];
        assert_eq!(pick_home(&roots).as_deref(), Some("C:\\atelier\\nova"));
        /* A trailing separator is a spelling of the same place, and the
        comparison is on the folder's name rather than the string. */
        let roots = vec!["C:\\atelier\\workbench\\".to_string()];
        assert_eq!(
            pick_home(&roots).as_deref(),
            Some("C:\\atelier\\workbench\\")
        );
        assert!(pick_home(&[]).is_none());
    }
}
