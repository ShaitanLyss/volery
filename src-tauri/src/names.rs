//! What a card is called, asked by handle — closed cards included.
//!
//! Every surface that draws a card by its handle goes through one resolver on
//! the front end (`src/lib/whois.ts`), and that resolver can see the cards on
//! the wall and the cards on other walls by itself. What it cannot see is a card
//! that has been **closed** and is still in the store: a relay from it, a notice
//! it posted, a plate it drew, a question it asked before it went. Those were
//! drawn as their handle — eight hex characters naming nothing — and Lyss's
//! "some ids are still showing raw" (2026-10-21) was largely them.
//!
//! The `conversation` row outlives the card (`closed_at` is a timestamp, never a
//! delete), so its title is still there to be read. This is the read, and
//! nothing else: no roster, no project, no state — a name is all a person
//! reading a header needs.

use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::Manager;

use crate::store::Store;

/// What the store calls a card a handle names.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Named {
    /// The handle as it was asked — the front end keys its answers on it.
    pub handle: String,
    pub title: String,
    pub closed: bool,
}

/// How many handles one ask may carry. The front end gathers a render's worth
/// into one call; this is the bound on what a caller holding the IPC can ask
/// in one go, since every handle is a query.
const MOST: usize = 200;

/// The card each handle names, for those the store holds — on this wall,
/// open or closed. A handle that names two cards is the case `relay.rs`
/// refuses by name, and it is not answered here either: a name for one of two
/// cards is a name that may be the wrong card's.
pub(crate) fn titles(conn: &Connection, handles: &[String]) -> Result<Vec<Named>, String> {
    let mut q = conn
        .prepare(
            "SELECT title, closed_at IS NOT NULL FROM conversation
              WHERE substr(id, 1, ?1) = ?2 LIMIT 2",
        )
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for h in handles.iter().take(MOST) {
        let h = h.trim().to_ascii_lowercase();
        /* The shape the front end asks with; anything else is not a handle and
           a prefix match on it would be a search, not a lookup. */
        if h.len() < 8 || h.len() > 36 || !h.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
            continue;
        }
        let rows: Vec<(String, bool)> = q
            .query_map(params![h.chars().count() as i64, h], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        if let [(title, closed)] = rows.as_slice() {
            out.push(Named { handle: h, title: title.clone(), closed: *closed });
        }
    }
    Ok(out)
}

/// The title of one card by its full id, open or closed, if it has one.
/// `untitled` is the column's default and is no name, so it reads as none.
pub(crate) fn title_of(conn: &Connection, id: &str) -> Option<String> {
    conn.query_row("SELECT title FROM conversation WHERE id = ?1", params![id], |r| r.get::<_, String>(0))
        .ok()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty() && t != "untitled")
}

/// The front end's door: names for the handles it could not resolve itself.
/// `async` and off the main thread, per CLAUDE.md, since it takes the store lock.
#[tauri::command]
pub async fn card_titles(app: tauri::AppHandle, handles: Vec<String>) -> Result<Vec<Named>, String> {
    crate::off_main(move || {
        let store = app.state::<Store>();
        let conn = store.0.lock().unwrap();
        titles(&conn, &handles)
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        crate::store::migrate(&conn).unwrap();
        conn.execute(
            "INSERT INTO project (id, name, root_path, created_at) VALUES ('p', 'p', 'C:/p', 0)",
            [],
        )
        .unwrap();
        conn
    }

    fn card(conn: &Connection, id: &str, title: &str, closed: bool) {
        conn.execute(
            "INSERT INTO conversation (id, project_id, cwd, title, born_at, closed_at)
             VALUES (?1, 'p', 'C:/p', ?2, 0, ?3)",
            params![id, title, if closed { Some(5) } else { None::<i64> }],
        )
        .unwrap();
    }

    #[test]
    fn a_closed_card_is_still_named_by_its_handle() {
        let conn = db();
        card(&conn, "6f90401a-1111-2222-3333-444455556666", "NOVA Coordinator", true);
        let got = titles(&conn, &["6f90401a".into()]).unwrap();
        assert_eq!(
            got,
            vec![Named { handle: "6f90401a".into(), title: "NOVA Coordinator".into(), closed: true }]
        );
    }

    #[test]
    fn an_open_card_answers_too_and_says_so() {
        let conn = db();
        card(&conn, "abcdef01-0000-0000-0000-000000000000", "the build", false);
        let got = titles(&conn, &["ABCDEF01".into()]).unwrap();
        assert_eq!(got.len(), 1);
        assert!(!got[0].closed);
        assert_eq!(got[0].handle, "abcdef01");
    }

    /* Two cards sharing a handle is `relay.rs`'s refusal; naming one of them
       would be naming a card that may be the wrong one. */
    #[test]
    fn a_handle_two_cards_share_is_not_answered() {
        let conn = db();
        card(&conn, "12345678-aaaa-0000-0000-000000000000", "one", true);
        card(&conn, "12345678-bbbb-0000-0000-000000000000", "two", false);
        assert!(titles(&conn, &["12345678".into()]).unwrap().is_empty());
        assert_eq!(titles(&conn, &["12345678-bbbb".into()]).unwrap()[0].title, "two");
    }

    #[test]
    fn anything_not_shaped_like_a_handle_is_not_searched_for() {
        let conn = db();
        card(&conn, "12345678-aaaa-0000-0000-000000000000", "one", true);
        for junk in ["", "1234", "1234567%", "zzzzzzzz", "' OR 1=1 --"] {
            assert!(titles(&conn, &[junk.to_string()]).unwrap().is_empty(), "{junk}");
        }
    }

    #[test]
    fn untitled_is_no_name() {
        let conn = db();
        card(&conn, "aaaaaaaa-0000-0000-0000-000000000000", "untitled", true);
        card(&conn, "bbbbbbbb-0000-0000-0000-000000000000", "  the plan  ", true);
        assert_eq!(title_of(&conn, "aaaaaaaa-0000-0000-0000-000000000000"), None);
        assert_eq!(title_of(&conn, "bbbbbbbb-0000-0000-0000-000000000000").as_deref(), Some("the plan"));
        assert_eq!(title_of(&conn, "nope"), None);
    }
}
