//! Glass spots, kept per screen arrangement.
//!
//! Where you put something on the glass is a fact about the screens in front of
//! you, and the wall has two quite different sets of them: unspread it is one
//! screen's worth of window, spread (`span.ts`) it is every monitor at once.
//! Those are not the same room with more furniture in it — they are different
//! rooms, and one room's arrangement read back in the other is a pile in the
//! corner. So a spot is stored against an *arrangement*, and switching to one
//! that has never been seen copies the most similar one rather than handing you
//! an empty pane.
//!
//! What an arrangement *is* — the shape of the screens, normalised so it is
//! about disposition and orientation rather than about which monitor is which —
//! and which known one a new one is most like are both `src/lib/arrange.ts`,
//! pure and tested there. Nothing in this file looks inside `screens_json`; it
//! is the front end's own, in the `widget.config_json` tradition, and Rust only
//! ever hands it back. The *choice* of ancestor arrives as `clone_from`, so the
//! metric has one home and it is the one with the tests around it.
//!
//! ### The columns are a cache of the current arrangement
//!
//! Every glass spot still lives where it always did — `placement.glass_x`,
//! `project.glass_x`, `reference_image.glass_x`, `widget.glass_x`,
//! `timeline.glass_x` — so every read path in the app is untouched and an older
//! build opening this file still finds a wall it understands. `glass_spot` is
//! the record, the columns are the arrangement you are in, and `adopt` is the
//! one place they are reconciled.
//!
//! **Written through rather than harvested on the way out.** The obvious design
//! is to copy the columns into the table when you leave an arrangement, and it
//! is the wrong one for the reason `set_mid_turn` learned: bookkeeping that
//! records how far something got must not be deferred to after the getting
//! there. A crash is the exit that saves nothing, so every writer calls
//! `remember` at the moment of the write and the table is never behind.

use rusqlite::{params, Connection};
use serde::Serialize;
use std::collections::HashMap;

use tauri::Manager;

use crate::store::Store;

/// Which of the five things on the glass a spot belongs to. One short string
/// per table, because the spot table is one table rather than five.
pub(crate) const CARD: &str = "card";
pub(crate) const PROJECT: &str = "project";
pub(crate) const IMAGE: &str = "image";
pub(crate) const WIDGET: &str = "widget";
pub(crate) const TIMELINE: &str = "timeline";
/// A grouping of cards inside a project — what the wall draws as a region.
///
/// Keyed by the territory's own id, where `PROJECT` above is keyed by a
/// `root_path`. That is the whole of why this is a sixth kind rather than a
/// change to the fifth: `migrate_v42` rewrites the stuck regions on every
/// arrangement from one to the other, and a kind whose key column changed
/// meaning underneath it would have been unreadable either side of the rung.
pub(crate) const TERRITORY: &str = "territory";

/// Every kind, with the table and key column the columns live in. One list, so
/// adding a sixth thing to the glass cannot be half-done: the reconcile, the
/// seed and the read all walk this.
const KINDS: &[(&str, &str, &str)] = &[
    (CARD, "placement", "conversation_id"),
    (PROJECT, "project", "root_path"),
    /* `TERRITORY` is deliberately NOT here yet. The reconcile below clears as
       well as sets, so a kind listed with no rows written for it would empty
       `territory.glass_x` on the first arrangement change — throwing away the
       values `migrate_v42` seeded from the projects, before anything has had a
       chance to read them. It joins this list in the same change that makes
       `stick_territory` the caller and re-keys the existing rows. */
    (IMAGE, "reference_image", "id"),
    (WIDGET, "widget", "id"),
    (TIMELINE, "timeline", "id"),
];

/// What is on the glass in one arrangement, by kind and by the id each kind is
/// keyed on. Handed back by `adopt` so the front end can move what it is
/// already holding instead of reloading the wall — which would reset a great
/// deal that has nothing to do with screens.
#[derive(Debug, Default, Serialize)]
pub struct GlassSpots {
    pub cards: HashMap<String, [f64; 2]>,
    pub projects: HashMap<String, [f64; 2]>,
    pub images: HashMap<String, [f64; 2]>,
    pub widgets: HashMap<String, [f64; 2]>,
    pub timelines: HashMap<String, [f64; 2]>,
}

impl GlassSpots {
    fn slot(&mut self, kind: &str) -> &mut HashMap<String, [f64; 2]> {
        match kind {
            CARD => &mut self.cards,
            PROJECT => &mut self.projects,
            IMAGE => &mut self.images,
            WIDGET => &mut self.widgets,
            _ => &mut self.timelines,
        }
    }
}

/// A known arrangement, as the front end needs it to pick an ancestor.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownArrangement {
    pub key: String,
    /// Opaque here. `src/lib/arrange.ts`'s `Screen[]`, as JSON.
    pub screens: String,
    pub seen_at: i64,
}

/// The arrangement the columns currently hold, or `None` before the front end
/// has said which one it is looking at.
pub(crate) fn current(conn: &Connection) -> Option<String> {
    conn.query_row(
        "SELECT key FROM arrangement WHERE current = 1",
        [],
        |r| r.get::<_, String>(0),
    )
    .ok()
}

/// Write one spot down against the arrangement in front of you.
///
/// Called by every writer that touches a `glass_x`/`glass_y` pair, right beside
/// the write itself. `None` for either coordinate is "on the wall", which is a
/// real state and is stored as the absence of a row — the same thing the
/// nullable columns say, and the reason there is no COALESCE in either place.
///
/// A failure here is not worth failing the placement for: the columns are
/// already written, so the wall is right and only the memory of this
/// arrangement is behind. It is returned rather than swallowed so a caller in a
/// transaction can still decide otherwise; the five callers all log and carry
/// on.
pub(crate) fn remember(
    conn: &Connection,
    kind: &str,
    id: &str,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<(), String> {
    let Some(key) = current(conn) else { return Ok(()) };
    match (x, y) {
        (Some(x), Some(y)) => conn.execute(
            "INSERT INTO glass_spot (arrangement, kind, ref, x, y)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(arrangement, kind, ref) DO UPDATE SET x = ?4, y = ?5",
            params![key, kind, id, x, y],
        ),
        _ => conn.execute(
            "DELETE FROM glass_spot WHERE arrangement = ?1 AND kind = ?2 AND ref = ?3",
            params![key, kind, id],
        ),
    }
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Take something off the glass in **every** room, because it no longer exists.
///
/// `remember` is about where a thing is; this is about a thing that is gone,
/// and the difference is the one id in `KINDS` that gets reused. A conversation,
/// an image, a widget and a timeline are uuids, so a stale row is dead weight
/// and nothing worse. A project's ref is its `root_path` — so a territory stuck
/// to the glass, removed, and then added back from the same folder came back
/// *still stuck*, at the spot the old one had, in a room the user had never put
/// it in. The row outlived the thing and then found a new thing with its name.
///
/// Across all arrangements rather than the current one: the thing is gone
/// everywhere, and a row left in a room you are not standing in is one that
/// surfaces the next time you walk into it.
pub(crate) fn forget(conn: &Connection, kind: &str, id: &str) {
    if let Err(e) = conn.execute(
        "DELETE FROM glass_spot WHERE kind = ?1 AND ref = ?2",
        params![kind, id],
    ) {
        eprintln!("skein: could not forget a glass spot ({kind} {id}): {e}");
    }
}

/// `remember`, with the failure logged instead of returned.
///
/// What the five writers actually call. The placement itself has already landed
/// by the time this runs, so a failure costs this arrangement's memory of one
/// spot and nothing else — and turning that into a failed drag would be the
/// wrong trade in the loudest possible way.
pub(crate) fn note(conn: &Connection, kind: &str, id: &str, x: Option<f64>, y: Option<f64>) {
    if let Err(e) = remember(conn, kind, id, x, y) {
        eprintln!("skein: could not remember a glass spot ({kind} {id}): {e}");
    }
}

/// Every arrangement this wall has ever been looked at in.
#[tauri::command]
pub async fn known_arrangements(app: tauri::AppHandle) -> Result<Vec<KnownArrangement>, String> {
    /* `async` + `off_main`, which is the house rule for anything taking the
       store's mutex: a blocking arm runs inline on the thread that paints every
       card on the wall, and this one is asked every time you come back to the
       window. See the note over `crate::off_main`. */
    crate::off_main(move || {
        let store = app.state::<Store>();
        let conn = store.0.lock().unwrap();
        known_in(&conn)
    })
    .await?
}

fn known_in(conn: &Connection) -> Result<Vec<KnownArrangement>, String> {
    let mut q = conn
        .prepare("SELECT key, screens_json, seen_at FROM arrangement ORDER BY seen_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = q
        .query_map([], |r| {
            Ok(KnownArrangement {
                key: r.get(0)?,
                screens: r.get(1)?,
                seen_at: r.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Move the glass into an arrangement, and answer what is on it there.
///
/// The one place the table and the columns are reconciled, and it runs in a
/// transaction for the reason the migration ladder does: half of this leaves a
/// wall whose columns say one arrangement and whose table says another, with
/// nothing to tell them apart afterwards.
///
/// Three things happen, in order:
///
/// 1. **A first sighting is furnished.** An arrangement whose row does not
///    exist yet has never been seen, so it takes a copy of `clone_from` — or,
///    when this is the genuinely first run and there is nothing to copy, a copy
///    of whatever is on the glass right now, which is what every wall made
///    before this feature existed has in its columns. The row existing is the
///    test, deliberately, and not whether the arrangement has any spots: "I took
///    everything off the glass here" is a thing you did, and re-cloning over it
///    every time you came back would make it impossible to do.
/// 2. **The columns are rewritten from the table.** One correlated update per
///    kind, so anything with no row for this arrangement goes back on the wall
///    rather than keeping the last arrangement's spot.
/// 3. **The arrangement becomes the current one**, which is what `remember`
///    then writes against.
#[tauri::command]
pub async fn adopt_arrangement(
    app: tauri::AppHandle,
    key: String,
    screens: String,
    origin: [f64; 2],
    clone_from: Option<String>,
) -> Result<Option<GlassSpots>, String> {
    /* The empty key is "the monitors have not answered yet" and is not an
       arrangement. Adopting it would make the pre-measurement state its own
       room, with its own copy of the whole glass. */
    if key.is_empty() {
        return Ok(None);
    }
    /* Off the main thread for the reason `known_arrangements` is, and with more
       to answer for: `adopt_in` is a transaction carrying ten whole-table
       statements, and it runs at the moment you have just looked at the
       window. */
    crate::off_main(move || {
        let store = app.state::<Store>();
        let mut conn = store.0.lock().unwrap();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        adopt_in(&tx, &key, &screens, origin, clone_from.as_deref())?;
        let spots = spots_in(&tx, &key)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(Some(spots))
    })
    .await?
}

/// The work of `adopt_arrangement`, so the round trip can be tested without an
/// app around it.
pub(crate) fn adopt_in(
    conn: &Connection,
    key: &str,
    screens: &str,
    origin: [f64; 2],
    clone_from: Option<&str>,
) -> Result<(), String> {
    /* **"No row" and "could not tell" are not the same answer**, and `is_err()`
       said they were. This gate decides whether a room is furnished from
       somewhere else — an `INSERT OR REPLACE` over its spots, or a reseed from
       the columns — so a transient failure reading it would quietly overwrite
       an arrangement somebody had made. Matched explicitly, and anything that
       is not "no rows" is returned rather than guessed at. */
    let fresh = match conn.query_row(
        "SELECT 1 FROM arrangement WHERE key = ?1",
        params![key],
        |_| Ok(()),
    ) {
        Ok(()) => false,
        Err(rusqlite::Error::QueryReturnedNoRows) => true,
        Err(e) => return Err(format!("could not read arrangement {key}: {e}")),
    };

    /* The ancestor's origin has to be read before the upsert, since the
       arrangement being adopted may *be* its own ancestor's row on a re-adopt
       and the write below would move the number out from under the read. */
    let ancestor = clone_from
        .filter(|from| !from.is_empty() && *from != key)
        .map(|from| (from.to_string(), origin_of(conn, from)));

    conn.execute(
        "INSERT INTO arrangement (key, screens_json, seen_at, current, origin_x, origin_y)
         VALUES (?1, ?2, ?3, 0, ?4, ?5)
         ON CONFLICT(key) DO UPDATE SET
           screens_json = ?2, seen_at = ?3, origin_x = ?4, origin_y = ?5",
        params![key, screens, crate::store::now(), origin[0], origin[1]],
    )
    .map_err(|e| e.to_string())?;

    if fresh {
        match ancestor {
            Some((from, was)) => {
                /* Shifted by however far the pane's origin moved between the
                   two rooms, so the first spread finds the glass where it
                   already was rather than piled onto whichever monitor happens
                   to be the union's top-left.

                   The pane is the whole window while spread and the home
                   screen's share of it otherwise, so the *same place on the
                   home screen* is a different pair of numbers in the two rooms
                   — and the whole point of copying an arrangement is that it
                   arrives looking like the one it was copied from. Every spot
                   is still clamped onto the pane it lands on, so a shift that
                   is approximate (it is: the chrome is measured, not derived)
                   costs a few pixels on one seeding and nothing afterwards. */
                conn.execute(
                    "INSERT OR REPLACE INTO glass_spot (arrangement, kind, ref, x, y)
                     SELECT ?1, kind, ref, x + ?3, y + ?4 FROM glass_spot
                     WHERE arrangement = ?2",
                    params![key, from, origin[0] - was[0], origin[1] - was[1]],
                )
                .map_err(|e| e.to_string())?;
            }
            None => seed_from_columns(conn, key)?,
        }
    }

    reconcile(conn, key)?;

    conn.execute("UPDATE arrangement SET current = 0 WHERE current = 1", [])
        .map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE arrangement SET current = 1 WHERE key = ?1",
        params![key],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Where the pane's origin was when an arrangement was last in front of you,
/// in glass pixels. `[0, 0]` for one nobody has recorded, which is also the
/// true answer for every unspread room.
fn origin_of(conn: &Connection, key: &str) -> [f64; 2] {
    conn.query_row(
        "SELECT origin_x, origin_y FROM arrangement WHERE key = ?1",
        params![key],
        |r| Ok([r.get::<_, f64>(0)?, r.get::<_, f64>(1)?]),
    )
    .unwrap_or([0.0, 0.0])
}

/// The first arrangement ever identified inherits the glass as it stands.
///
/// Every wall made before this existed has its spots in the columns and nothing
/// in the table, and the alternative to this is that the first launch after the
/// update finds the glass empty — which is the whole of what somebody would
/// notice, and it would read as having lost their arrangement rather than as
/// having gained a feature.
fn seed_from_columns(conn: &Connection, key: &str) -> Result<(), String> {
    for (kind, table, idc) in KINDS {
        conn.execute(
            &format!(
                "INSERT OR REPLACE INTO glass_spot (arrangement, kind, ref, x, y)
                 SELECT ?1, '{kind}', {idc}, glass_x, glass_y FROM {table}
                 WHERE glass_x IS NOT NULL AND glass_y IS NOT NULL"
            ),
            params![key],
        )
        .map_err(|e| format!("seed {kind}: {e}"))?;
    }
    Ok(())
}

/// Point the columns at one arrangement's spots.
///
/// A correlated subquery rather than a clear-then-apply, so there is no instant
/// at which the wall has been emptied — and so that "no row here" and "on the
/// wall" are the same statement rather than two that could disagree.
fn reconcile(conn: &Connection, key: &str) -> Result<(), String> {
    for (kind, table, idc) in KINDS {
        conn.execute(
            &format!(
                "UPDATE {table} SET
                   glass_x = (SELECT s.x FROM glass_spot s
                               WHERE s.arrangement = ?1 AND s.kind = '{kind}' AND s.ref = {table}.{idc}),
                   glass_y = (SELECT s.y FROM glass_spot s
                               WHERE s.arrangement = ?1 AND s.kind = '{kind}' AND s.ref = {table}.{idc})"
            ),
            params![key],
        )
        .map_err(|e| format!("reconcile {kind}: {e}"))?;
    }
    Ok(())
}

/// What one arrangement has on its glass.
pub(crate) fn spots_in(conn: &Connection, key: &str) -> Result<GlassSpots, String> {
    let mut q = conn
        .prepare("SELECT kind, ref, x, y FROM glass_spot WHERE arrangement = ?1")
        .map_err(|e| e.to_string())?;
    let rows = q
        .query_map(params![key], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, f64>(2)?,
                r.get::<_, f64>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut out = GlassSpots::default();
    for row in rows {
        let (kind, id, x, y) = row.map_err(|e| e.to_string())?;
        out.slot(&kind).insert(id, [x, y]);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    /// The five tables this touches, plus the two it owns. Not `store::open`,
    /// which wants a whole app directory — the point here is the reconcile.
    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE placement (conversation_id TEXT PRIMARY KEY, glass_x REAL, glass_y REAL);
            CREATE TABLE project (root_path TEXT PRIMARY KEY, glass_x REAL, glass_y REAL);
            CREATE TABLE reference_image (id TEXT PRIMARY KEY, glass_x REAL, glass_y REAL);
            CREATE TABLE widget (id TEXT PRIMARY KEY, glass_x REAL, glass_y REAL);
            CREATE TABLE timeline (id TEXT PRIMARY KEY, glass_x REAL, glass_y REAL);
            CREATE TABLE arrangement (
                key          TEXT PRIMARY KEY,
                screens_json TEXT NOT NULL,
                seen_at      INTEGER NOT NULL,
                current      INTEGER NOT NULL DEFAULT 0,
                origin_x     REAL NOT NULL DEFAULT 0,
                origin_y     REAL NOT NULL DEFAULT 0
            );
            CREATE TABLE glass_spot (
                arrangement TEXT NOT NULL,
                kind        TEXT NOT NULL,
                ref         TEXT NOT NULL,
                x           REAL NOT NULL,
                y           REAL NOT NULL,
                PRIMARY KEY (arrangement, kind, ref)
            );
            "#,
        )
        .unwrap();
        conn
    }

    /// Stick a card to the glass the way a *writer* does: the column and the
    /// row, together.
    ///
    /// `note` is only ever half of a placement — `save_placement` writes
    /// `placement.glass_x` itself and calls `note` beside it, which is the
    /// whole of the "the columns are a cache of the room you are in" bargain.
    /// A test calling `note` alone and then reading the column asserts
    /// something no code path in this app does, and that is exactly what one of
    /// these did. It failed nowhere until the module could run at all.
    ///
    /// `nothing_is_remembered_before_an_arrangement_is_known` still calls
    /// `note` bare on purpose: its whole subject is what that half does alone.
    fn stick(conn: &Connection, id: &str, x: Option<f64>, y: Option<f64>) {
        conn.execute(
            "UPDATE placement SET glass_x = ?2, glass_y = ?3 WHERE conversation_id = ?1",
            params![id, x, y],
        )
        .unwrap();
        note(conn, CARD, id, x, y);
    }

    fn card_spot(conn: &Connection, id: &str) -> Option<(f64, f64)> {
        conn.query_row(
            "SELECT glass_x, glass_y FROM placement WHERE conversation_id = ?1",
            params![id],
            |r| Ok((r.get::<_, Option<f64>>(0)?, r.get::<_, Option<f64>>(1)?)),
        )
        .ok()
        .and_then(|(x, y)| Some((x?, y?)))
    }

    #[test]
    fn the_first_arrangement_inherits_the_glass_as_it_stands() {
        // Every wall made before this feature has its spots in the columns and
        // nothing in the table. Finding the glass empty after an update would
        // read as having lost an arrangement, not as having gained a feature.
        let conn = db();
        conn.execute(
            "INSERT INTO placement VALUES ('c1', 10.0, 20.0)",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO placement VALUES ('c2', NULL, NULL)", [])
            .unwrap();
        adopt_in(&conn, "one", "[]", [0.0, 0.0], None).unwrap();
        assert_eq!(card_spot(&conn, "c1"), Some((10.0, 20.0)));
        assert_eq!(card_spot(&conn, "c2"), None);
        assert_eq!(spots_in(&conn, "one").unwrap().cards.len(), 1);
    }

    #[test]
    fn a_new_arrangement_is_duplicated_from_the_one_it_was_told_to_copy() {
        let conn = db();
        conn.execute("INSERT INTO placement VALUES ('c1', 10.0, 20.0)", [])
            .unwrap();
        adopt_in(&conn, "one", "[]", [0.0, 0.0], None).unwrap();
        adopt_in(&conn, "two", "[]", [0.0, 0.0], Some("one")).unwrap();
        assert_eq!(card_spot(&conn, "c1"), Some((10.0, 20.0)));
        // And the two are now separate rooms.
        stick(&conn, "c1", Some(99.0), Some(98.0));
        adopt_in(&conn, "one", "[]", [0.0, 0.0], None).unwrap();
        assert_eq!(card_spot(&conn, "c1"), Some((10.0, 20.0)));
        adopt_in(&conn, "two", "[]", [0.0, 0.0], None).unwrap();
        assert_eq!(card_spot(&conn, "c1"), Some((99.0, 98.0)));
    }

    #[test]
    fn an_arrangement_you_emptied_stays_empty() {
        /* The test for "never seen" is the arrangement row, not whether it has
           any spots. Otherwise taking everything off the glass in one room
           would be undone every time you walked back into it. */
        let conn = db();
        conn.execute("INSERT INTO placement VALUES ('c1', 10.0, 20.0)", [])
            .unwrap();
        adopt_in(&conn, "one", "[]", [0.0, 0.0], None).unwrap();
        adopt_in(&conn, "two", "[]", [0.0, 0.0], Some("one")).unwrap();
        stick(&conn, "c1", None, None);
        adopt_in(&conn, "one", "[]", [0.0, 0.0], None).unwrap();
        adopt_in(&conn, "two", "[]", [0.0, 0.0], Some("one")).unwrap();
        assert_eq!(card_spot(&conn, "c1"), None);
    }

    #[test]
    fn leaving_an_arrangement_puts_back_what_it_does_not_hold() {
        /* The reconcile has to clear as well as set: a card stuck in one room
           and never stuck in the other must be on the wall in the other, not
           sitting where the last room left it. */
        let conn = db();
        conn.execute("INSERT INTO placement VALUES ('c1', NULL, NULL)", [])
            .unwrap();
        adopt_in(&conn, "one", "[]", [0.0, 0.0], None).unwrap();
        adopt_in(&conn, "two", "[]", [0.0, 0.0], Some("one")).unwrap();
        stick(&conn, "c1", Some(5.0), Some(6.0));
        assert_eq!(card_spot(&conn, "c1"), Some((5.0, 6.0)));
        adopt_in(&conn, "one", "[]", [0.0, 0.0], None).unwrap();
        assert_eq!(card_spot(&conn, "c1"), None);
    }

    #[test]
    fn every_kind_on_the_glass_is_carried() {
        // One list drives the seed and the reconcile, so a sixth thing on the
        // glass cannot be half-done — this is the assertion that says so.
        let conn = db();
        conn.execute("INSERT INTO placement VALUES ('c', 1.0, 2.0)", []).unwrap();
        conn.execute("INSERT INTO project VALUES ('/p', 3.0, 4.0)", []).unwrap();
        conn.execute("INSERT INTO reference_image VALUES ('i', 5.0, 6.0)", []).unwrap();
        conn.execute("INSERT INTO widget VALUES ('w', 7.0, 8.0)", []).unwrap();
        conn.execute("INSERT INTO timeline VALUES ('t', 9.0, 10.0)", []).unwrap();
        adopt_in(&conn, "one", "[]", [0.0, 0.0], None).unwrap();
        let s = spots_in(&conn, "one").unwrap();
        assert_eq!(s.cards.get("c"), Some(&[1.0, 2.0]));
        assert_eq!(s.projects.get("/p"), Some(&[3.0, 4.0]));
        assert_eq!(s.images.get("i"), Some(&[5.0, 6.0]));
        assert_eq!(s.widgets.get("w"), Some(&[7.0, 8.0]));
        assert_eq!(s.timelines.get("t"), Some(&[9.0, 10.0]));
    }

    #[test]
    fn nothing_is_remembered_before_an_arrangement_is_known() {
        // The launch window before the monitors have answered. The columns are
        // still the truth there, and the first adopt seeds from them.
        let conn = db();
        note(&conn, CARD, "c1", Some(1.0), Some(2.0));
        assert!(current(&conn).is_none());
        assert_eq!(spots_in(&conn, "one").unwrap().cards.len(), 0);
    }

    #[test]
    fn an_arrangement_is_never_cloned_from_itself() {
        let conn = db();
        conn.execute("INSERT INTO placement VALUES ('c1', 1.0, 2.0)", []).unwrap();
        adopt_in(&conn, "one", "[]", [0.0, 0.0], Some("one")).unwrap();
        // Fell back to the columns rather than copying nothing over nothing.
        assert_eq!(card_spot(&conn, "c1"), Some((1.0, 2.0)));
    }

    #[test]
    fn a_copied_arrangement_arrives_looking_like_the_one_it_came_from() {
        /* The pane is the home screen's share of the window unspread and the
           whole window spread, so the same place on the home screen is a
           different pair of numbers in the two rooms. Without the shift the
           first spread piles the glass onto whichever monitor is the union's
           top-left. */
        let conn = db();
        conn.execute("INSERT INTO placement VALUES ('c1', 100.0, 50.0)", []).unwrap();
        adopt_in(&conn, "one", "[]", [0.0, 0.0], None).unwrap();
        // Spreading: the home screen now starts 1080 across and 60 down.
        adopt_in(&conn, "wide", "[]", [1080.0, 60.0], Some("one")).unwrap();
        assert_eq!(card_spot(&conn, "c1"), Some((1180.0, 110.0)));
        // And back: the same place on the home screen again.
        adopt_in(&conn, "one", "[]", [0.0, 0.0], None).unwrap();
        assert_eq!(card_spot(&conn, "c1"), Some((100.0, 50.0)));
    }

    #[test]
    fn a_thing_that_is_gone_leaves_every_room() {
        /* A project's ref is its `root_path`, which is the one id here that
           gets reused: stick a territory to the glass, remove it, add the same
           folder back, and the row found a new thing with its name. */
        let conn = db();
        conn.execute("INSERT INTO project VALUES ('/p', 3.0, 4.0)", []).unwrap();
        adopt_in(&conn, "one", "[]", [0.0, 0.0], None).unwrap();
        adopt_in(&conn, "two", "[]", [0.0, 0.0], Some("one")).unwrap();
        forget(&conn, PROJECT, "/p");
        // Gone from the room it was deleted in, and from the other one too.
        assert!(spots_in(&conn, "two").unwrap().projects.is_empty());
        assert!(spots_in(&conn, "one").unwrap().projects.is_empty());
        // And the folder added back is on the wall, not where the old one was.
        conn.execute("UPDATE project SET glass_x = NULL, glass_y = NULL", []).unwrap();
        adopt_in(&conn, "one", "[]", [0.0, 0.0], None).unwrap();
        let back: Option<f64> = conn
            .query_row("SELECT glass_x FROM project WHERE root_path = '/p'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(back, None);
    }

    #[test]
    fn an_arrangement_that_cannot_be_read_is_not_treated_as_new() {
        /* `is_err()` conflated "no row" with "could not tell", and the gate it
           guards clones over a room's real spots. */
        let conn = db();
        conn.execute("DROP TABLE arrangement", []).unwrap();
        assert!(adopt_in(&conn, "one", "[]", [0.0, 0.0], None).is_err());
    }

    #[test]
    fn only_one_arrangement_is_ever_current() {
        let conn = db();
        adopt_in(&conn, "one", "[]", [0.0, 0.0], None).unwrap();
        adopt_in(&conn, "two", "[]", [0.0, 0.0], None).unwrap();
        adopt_in(&conn, "three", "[]", [0.0, 0.0], None).unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM arrangement WHERE current = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
        assert_eq!(current(&conn).as_deref(), Some("three"));
    }
}
