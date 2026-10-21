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
    /// The agent session it last held, which is what bringing a closed card
    /// back resumes — `importable` lists sessions, not cards, and a card that
    /// was cleared holds a session that is not its id.
    pub session: Option<String>,
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
            "SELECT title, closed_at IS NOT NULL, agent_session_id FROM conversation
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
        let rows: Vec<(String, bool, Option<String>)> = q
            .query_map(params![h.chars().count() as i64, h], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        if let [(title, closed, session)] = rows.as_slice() {
            out.push(Named { handle: h, title: title.clone(), closed: *closed, session: session.clone() });
        }
    }
    Ok(out)
}

/// What else an eight-character id can name. A card's handle is not the only id
/// an agent writes in prose: a sink item's is the same eight characters of a
/// uuid, and so is a billboard notice's. Lyss, 2026-10-21: *"I want all of those
/// to become decorated and clickable, everywhere"* — cards, sinks, notices,
/// commits.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Other {
    /// The id as it was asked.
    pub handle: String,
    /// `sink` or `notice`.
    pub kind: &'static str,
    pub title: String,
    /// A sink item that has been dealt with. A notice is never settled; it is
    /// taken down, and then it is not here.
    pub settled: bool,
}

/// The sink item or notice each id names, for those the store holds. A card
/// outranks both and is asked separately (`titles`); this is only ever asked
/// about an id no card answered to. An id that names two rows, in one table or
/// across both, is not answered — the same refusal `titles` makes, for the same
/// reason: a name for one of two things may be the wrong one's.
pub(crate) fn others(conn: &Connection, handles: &[String]) -> Result<Vec<Other>, String> {
    let mut sink = conn
        .prepare("SELECT title, settled_at IS NOT NULL FROM sink_item WHERE substr(id, 1, ?1) = ?2 LIMIT 2")
        .map_err(|e| e.to_string())?;
    let mut notice = conn
        .prepare("SELECT subject FROM notice WHERE substr(id, 1, ?1) = ?2 LIMIT 2")
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for h in handles.iter().take(MOST) {
        let h = h.trim().to_ascii_lowercase();
        if h.len() < 8 || h.len() > 36 || !h.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
            continue;
        }
        let n = h.chars().count() as i64;
        let sinks: Vec<(String, bool)> = sink
            .query_map(params![n, h], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        let notices: Vec<String> = notice
            .query_map(params![n, h], |r| r.get(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        match (sinks.as_slice(), notices.as_slice()) {
            ([(title, settled)], []) => {
                out.push(Other { handle: h, kind: "sink", title: title.clone(), settled: *settled })
            }
            ([], [subject]) => out.push(Other { handle: h, kind: "notice", title: subject.clone(), settled: false }),
            _ => {}
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn other_names(app: tauri::AppHandle, handles: Vec<String>) -> Result<Vec<Other>, String> {
    crate::off_main(move || {
        let store = app.state::<Store>();
        let conn = store.0.lock().unwrap();
        others(&conn, &handles)
    })
    .await?
}

/// A commit, as a sentence needs it.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Commit {
    /// As it was asked (lower-cased), the key the front end holds answers under.
    pub handle: String,
    pub short: String,
    pub subject: String,
    pub author: String,
    /// Unix seconds.
    pub at: i64,
}

/// Seven to forty hex characters is what git itself accepts as an abbreviation
/// of an object name; anything else is not asked about, so nothing here can be
/// made to read a ref, a range or an option.
pub(crate) fn is_sha(s: &str) -> bool {
    (7..=40).contains(&s.len()) && s.chars().all(|c| c.is_ascii_hexdigit())
}

/// The commit a hash names in `root`, if it names exactly one. `^{commit}`
/// peels a tag and refuses a tree or a blob, so a hash that is some other
/// object reads as nothing rather than as a commit it is not. An ambiguous
/// abbreviation makes git fail, which reads as nothing too.
pub(crate) fn commit_of(root: &str, sha: &str) -> Option<Commit> {
    if !is_sha(sha) {
        return None;
    }
    let spec = format!("{sha}^{{commit}}");
    let (ok, out, _) = crate::worktree::run(
        root,
        &["show", "-s", "--no-show-signature", "--format=%h%x1f%s%x1f%an%x1f%at", &spec, "--"],
    );
    if !ok {
        return None;
    }
    let mut f = out.split('\u{1f}');
    let short = f.next()?.to_string();
    let subject = f.next()?.to_string();
    let author = f.next()?.to_string();
    let at = f.next()?.trim().parse().ok()?;
    Some(Commit { handle: sha.to_ascii_lowercase(), short, subject, author, at })
}

/// At most this many hashes per ask, and each is a git spawn.
const MOST_COMMITS: usize = 12;

/// The commits `shas` name in `root`. A directory that is not a repository, or
/// is not there, answers nothing: a prose hash in a card with no repo is text.
#[tauri::command]
pub async fn commit_names(root: String, shas: Vec<String>) -> Result<Vec<Commit>, String> {
    crate::off_main(move || {
        if !std::path::Path::new(&root).is_dir() {
            return Vec::new();
        }
        shas.iter().take(MOST_COMMITS).filter_map(|s| commit_of(&root, s.trim())).collect()
    })
    .await
}

/// A commit in full, for the sheet that opens over a hash: the whole message
/// and the files it touched. Asked on the click, never while a transcript
/// renders.
#[derive(Debug, Clone, Serialize)]
pub struct CommitDetail {
    pub handle: String,
    pub full: String,
    pub body: String,
    pub stat: String,
}

/// Bound on what a commit's message and stat can put on the wire.
const DETAIL_CAP: usize = 12_000;

#[tauri::command]
pub async fn commit_detail(root: String, sha: String) -> Result<Option<CommitDetail>, String> {
    crate::off_main(move || {
        let sha = sha.trim().to_string();
        if !is_sha(&sha) || !std::path::Path::new(&root).is_dir() {
            return None;
        }
        let spec = format!("{sha}^{{commit}}");
        let (ok, head, _) = crate::worktree::run(&root, &["show", "-s", "--no-show-signature", "--format=%H%x1f%B", &spec, "--"]);
        if !ok {
            return None;
        }
        let (full, body) = head.split_once('\u{1f}')?;
        let (_, stat, _) = crate::worktree::run(
            &root,
            &["show", "--no-show-signature", "--stat=100,60", "--format=", &spec, "--"],
        );
        let cut = |t: &str| -> String {
            if t.len() <= DETAIL_CAP {
                return t.to_string();
            }
            let mut end = DETAIL_CAP;
            while !t.is_char_boundary(end) {
                end -= 1;
            }
            format!("{}\n[… cut at {} characters]", &t[..end], DETAIL_CAP)
        };
        Some(CommitDetail { handle: sha.to_ascii_lowercase(), full: full.to_string(), body: cut(body.trim()), stat: cut(&stat) })
    })
    .await
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
            vec![Named { handle: "6f90401a".into(), title: "NOVA Coordinator".into(), closed: true, session: None }]
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

    fn sink_row(conn: &Connection, id: &str, title: &str, settled: bool) {
        conn.execute(
            "INSERT INTO sink_item (id, project_id, kind, title, body, dropped_at, touched_at, settled_at)
             VALUES (?1, NULL, 'bug', ?2, '', 0, 0, ?3)",
            params![id, title, if settled { Some(9) } else { None::<i64> }],
        )
        .unwrap();
    }

    fn notice_row(conn: &Connection, id: &str, subject: &str) {
        conn.execute(
            "INSERT INTO notice (id, scope, subject, body, posted_at, touched_at) VALUES (?1, 'skein', ?2, '', 0, 0)",
            params![id, subject],
        )
        .unwrap();
    }

    #[test]
    fn a_sink_item_and_a_notice_are_named_by_their_ids() {
        let conn = db();
        sink_row(&conn, "20422a14-0000-0000-0000-000000000000", "a wake is drawn as you", true);
        notice_row(&conn, "deadbeef-0000-0000-0000-000000000000", "reworking the panel");
        let got = others(&conn, &["20422A14".into(), "deadbeef".into(), "00000000".into()]).unwrap();
        assert_eq!(
            got,
            vec![
                Other { handle: "20422a14".into(), kind: "sink", title: "a wake is drawn as you".into(), settled: true },
                Other { handle: "deadbeef".into(), kind: "notice", title: "reworking the panel".into(), settled: false },
            ]
        );
    }

    /* An id naming a sink item and a notice at once is an id that may be the
       wrong one's, so it names neither. */
    #[test]
    fn an_id_two_rows_share_is_not_answered() {
        let conn = db();
        sink_row(&conn, "cafe0000-aaaa-0000-0000-000000000000", "one", false);
        notice_row(&conn, "cafe0000-bbbb-0000-0000-000000000000", "two");
        assert!(others(&conn, &["cafe0000".into()]).unwrap().is_empty());
        assert_eq!(others(&conn, &["cafe0000-bbbb".into()]).unwrap()[0].kind, "notice");
    }

    #[test]
    fn only_a_hash_shaped_string_reaches_git() {
        for ok in ["abcdef1", "ABCDEF1234", &"a".repeat(40)] {
            assert!(is_sha(ok), "{ok}");
        }
        for no in ["", "abcdef", &"a".repeat(41), "abcdefg", "--all", "HEAD", "abc def1", "main^{commit}"] {
            assert!(!is_sha(no), "{no}");
        }
        /* and a refused one never starts a process */
        assert!(commit_of("C:/definitely/not/here", "--upload-pack=x").is_none());
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
