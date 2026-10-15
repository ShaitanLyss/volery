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
/// A card on another wall. **Not in `KINDS`**: it has no row and no columns here,
/// so `glass_spot` is its only record and `reconcile` must never touch it — a
/// kind listed there with nothing written clears that table's `glass_x`. The ref
/// is the shadow's id (`elsewhere:<host>:<card>`), which `adopt_in`'s clone
/// already carries and shifts with every other kind.
pub(crate) const SHADOW: &str = "shadow";
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
    /* A region's spot is the *territory's*, not the project's — `PROJECT` was
       here until v43, keyed on a `root_path`, which stopped being an identity
       the moment one checkout could carry three regions. `migrate_v43` re-keys
       the rows, and it has to land in the same change as this line: the
       reconcile below clears as well as sets, so a kind in this list with no
       rows written for it empties that table's `glass_x` on the first
       arrangement change. The `PROJECT` constant stays because `v41`'s merge
       still rewrites rows under the old kind, which is correct — that rung runs
       before this one.

       See `.claude/rules/arrange.md`. */
    (TERRITORY, "territory", "id"),
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
    pub territories: HashMap<String, [f64; 2]>,
    pub images: HashMap<String, [f64; 2]>,
    pub widgets: HashMap<String, [f64; 2]>,
    pub timelines: HashMap<String, [f64; 2]>,
    pub shadows: HashMap<String, [f64; 2]>,
}

impl GlassSpots {
    fn slot(&mut self, kind: &str) -> &mut HashMap<String, [f64; 2]> {
        match kind {
            CARD => &mut self.cards,
            TERRITORY => &mut self.territories,
            IMAGE => &mut self.images,
            WIDGET => &mut self.widgets,
            SHADOW => &mut self.shadows,
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
    /// The pane a one-screen room's spots are laid out in, in CSS pixels, or
    /// `None` — every spread room, and every room stored before v53, whose
    /// frame the front end estimates off `screens` instead. See `reframe`.
    pub frame: Option<[f64; 2]>,
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

/// Remember where a card on another wall is stuck to the glass, in the room in
/// front of you. `None` takes it off. Written through, like every other glass
/// writer, so a crash loses nothing.
#[tauri::command]
pub async fn stick_shadow(
    app: tauri::AppHandle,
    id: String,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<(), String> {
    crate::off_main(move || {
        let store = app.state::<Store>();
        let conn = store.0.lock().unwrap();
        remember(&conn, SHADOW, &id, x, y)
    })
    .await?
}

/// Let go of the spots of one wall's cards that its latest snapshot no longer
/// carries, in **every** room — a card its own wall closed will not come back,
/// so its spot would otherwise point at nothing for ever. Scoped to one host and
/// asked only when that wall has just been heard: a wall not heard from (a lid
/// shut, a launch before the link is up) says nothing about its cards, and
/// pruning on its silence would forget every spot you had made.
#[tauri::command]
pub async fn keep_shadow_glass(
    app: tauri::AppHandle,
    host: String,
    alive: Vec<String>,
) -> Result<usize, String> {
    crate::off_main(move || {
        let store = app.state::<Store>();
        let conn = store.0.lock().unwrap();
        keep_shadows(&conn, &host, &alive)
    })
    .await?
}

/// `substr` rather than `LIKE`: a host name is free text and `_`/`%` in it
/// would be wildcards.
pub(crate) fn keep_shadows(conn: &Connection, host: &str, alive: &[String]) -> Result<usize, String> {
    let prefix = format!("elsewhere:{host}:");
    let mut q = conn
        .prepare("SELECT DISTINCT ref FROM glass_spot WHERE kind = ?1 AND substr(ref, 1, ?2) = ?3")
        .map_err(|e| e.to_string())?;
    let refs: Vec<String> = q
        .query_map(params![SHADOW, prefix.chars().count() as i64, prefix], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    let mut gone = 0;
    for r in refs.iter().filter(|r| !alive.contains(r)) {
        forget(conn, SHADOW, r);
        gone += 1;
    }
    Ok(gone)
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
        .prepare(
            "SELECT key, screens_json, seen_at, frame_w, frame_h FROM arrangement
             ORDER BY seen_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = q
        .query_map([], |r| {
            Ok(KnownArrangement {
                key: r.get(0)?,
                screens: r.get(1)?,
                seen_at: r.get(2)?,
                frame: pair(r.get::<_, Option<f64>>(3)?, r.get::<_, Option<f64>>(4)?),
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
///
/// And before any of that, a room already known is **put back into the unit it
/// is being drawn in** (`unit`, see `rescale`), so the spots it hands back are
/// in the same physical places they were left in — and, on one screen, **into
/// the pane it is being drawn in** (`frame`, see `reframe`), so a glass laid out
/// on the laptop lands in the same relative places on the monitor beside it.
///
/// Which frame to map from is the front end's to say (`from_frame`,
/// `clone_frame`), for the reason the ancestor is: deciding it means reading
/// `screens_json`, which nothing in this file does. `sizes` is what each thing
/// on the glass is drawn at, by kind and id (`"*"` for every id of a kind),
/// since a thing that does not grow with the screen has to keep its edge.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn adopt_arrangement(
    app: tauri::AppHandle,
    key: String,
    screens: String,
    origin: [f64; 2],
    unit: Option<f64>,
    clone_from: Option<String>,
    frame: Option<[f64; 2]>,
    from_frame: Option<[f64; 2]>,
    clone_frame: Option<[f64; 2]>,
    sizes: Option<Sizes>,
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
        let framing = Framing {
            frame,
            from: from_frame,
            clone_from: clone_frame,
            sizes: sizes.as_ref(),
        };
        adopt_framed(&tx, &key, &screens, origin, unit, clone_from.as_deref(), &framing)?;
        let spots = spots_in(&tx, &key)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(Some(spots))
    })
    .await?
}

/// What each thing on the glass is drawn at, by kind and then by id, with `"*"`
/// standing for every id of a kind — a card is one size whichever card it is.
pub(crate) type Sizes = HashMap<String, HashMap<String, [f64; 2]>>;

/// How a one-screen room's spots are carried onto the pane in front of you.
/// All `None` is "nothing to say", which is every spread room and every caller
/// that predates frames.
#[derive(Default)]
pub(crate) struct Framing<'a> {
    /// The pane this room is about to be drawn in, recorded against it. `None`
    /// leaves whatever was recorded — a spread room has none and wants none.
    pub frame: Option<[f64; 2]>,
    /// The pane a known room's spots are laid out in now, when they are to be
    /// carried onto `frame`. `None` when the screen under them did not change.
    pub from: Option<[f64; 2]>,
    /// The same, for the ancestor a fresh room is copied from.
    pub clone_from: Option<[f64; 2]>,
    pub sizes: Option<&'a Sizes>,
}

/// The work of `adopt_arrangement`, so the round trip can be tested without an
/// app around it. With nothing to say about frames, which is what every test
/// written before them means.
#[cfg(test)]
pub(crate) fn adopt_in(
    conn: &Connection,
    key: &str,
    screens: &str,
    origin: [f64; 2],
    unit: Option<f64>,
    clone_from: Option<&str>,
) -> Result<(), String> {
    adopt_framed(conn, key, screens, origin, unit, clone_from, &Framing::default())
}

pub(crate) fn adopt_framed(
    conn: &Connection,
    key: &str,
    screens: &str,
    origin: [f64; 2],
    unit: Option<f64>,
    clone_from: Option<&str>,
    framing: &Framing,
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
    /* Likewise the unit this room's spots were last written in, before the
       upsert records the new one over it. */
    let was = if fresh { None } else { unit_of(conn, key) };

    /* The frame is written only when there is one to write — `COALESCE`, for
       once on purpose: `None` here is "no news", never "this room has no
       frame", and a launch that settled before the pane was measured must not
       erase what the spots are a share of. */
    let frame = framing.frame.filter(|f| sane(*f));
    conn.execute(
        "INSERT INTO arrangement
           (key, screens_json, seen_at, current, origin_x, origin_y, unit, frame_w, frame_h)
         VALUES (?1, ?2, ?3, 0, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(key) DO UPDATE SET
           screens_json = ?2, seen_at = ?3, origin_x = ?4, origin_y = ?5, unit = ?6,
           frame_w = COALESCE(?7, frame_w), frame_h = COALESCE(?8, frame_h)",
        params![
            key,
            screens,
            crate::store::now(),
            origin[0],
            origin[1],
            unit,
            frame.map(|f| f[0]),
            frame.map(|f| f[1]),
        ],
    )
    .map_err(|e| e.to_string())?;

    if let Some(k) = rescale(was, unit) {
        /* The same room, drawn at another scale: spread from a screen whose
           scale differs from the one it was last spread from. Every spot is
           multiplied about the pane's origin — the window's top-left, which is
           the union's top-left whichever screen is home — so each lands on the
           physical pixel it was left on. Shadows included, which is why this is
           over the table rather than over `KINDS`. */
        conn.execute(
            "UPDATE glass_spot SET x = x * ?2, y = y * ?2 WHERE arrangement = ?1",
            params![key, k],
        )
        .map_err(|e| e.to_string())?;
    }

    /* The same room on a screen of another size: every spot carried from the
       pane it was laid out in to the one it is about to be drawn in. Beside the
       unit rather than instead of it, and never with it — a unit is a spread
       room's and a frame a one-screen room's, so one adopt moves a room by at
       most one of the two. */
    if !fresh {
        if let (Some(from), Some(to)) = (framing.from, frame) {
            reframe(conn, key, from, to, framing.sizes)?;
        }
    }

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
                /* And a copy of a room laid out on a screen of another size is
                   that room *scaled to this one*: its pixels mean what they
                   meant in its own frame, and writing them into this one
                   unchanged would be saying they were laid out here. The front
                   end names no frame when the ancestor was on this very screen,
                   so flipping between the two modes moves nothing. */
                if let (Some(from), Some(to)) = (framing.clone_from, frame) {
                    reframe(conn, key, from, to, framing.sizes)?;
                }
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

/// The unit an arrangement's spots were last written in, or `None` for one that
/// was never told — every unspread room, and every room stored before the
/// column existed.
fn unit_of(conn: &Connection, key: &str) -> Option<f64> {
    conn.query_row(
        "SELECT unit FROM arrangement WHERE key = ?1",
        params![key],
        |r| r.get::<_, Option<f64>>(0),
    )
    .ok()
    .flatten()
}

/// How much to multiply a known room's spots by when it comes back under
/// another unit — `None` when there is nothing to do.
///
/// A glass spot is in CSS pixels, and while spread the page is zoomed to the
/// *home* screen's scale (`window.rs::rezoom`), so on a desk whose screens are
/// at different scales one CSS pixel is a different number of physical pixels
/// depending on which screen the window was spread from. Stored as they were,
/// the same spots then drew somewhere else — the laptop at 150% as home put the
/// whole glass two-thirds of the way to where it had been left from a monitor
/// at 100%. Which screen is home moves the chrome; it must not move the glass.
///
/// `was / now`: a spot `x` CSS pixels from the origin at `was` physical pixels
/// each is `x * was` physical pixels out, which at `now` each is
/// `x * was / now`. Nothing when either side is unknown — a room written before
/// the unit was recorded is assumed to be in the unit it is being read in,
/// which is right whenever its home has not changed and is the most that can
/// honestly be said when it has — and nothing for a difference no screen can
/// show, so a float that came back a hair different does not creep every spot
/// a hair each time.
pub(crate) fn rescale(was: Option<f64>, now: Option<f64>) -> Option<f64> {
    let (was, now) = (was?, now?);
    if !(was.is_finite() && now.is_finite() && was > 0.0 && now > 0.0) {
        return None;
    }
    let k = was / now;
    ((k - 1.0).abs() > 1e-6).then_some(k)
}

/// One axis of a spot, carried from a pane `from` long to one `to` long, for a
/// thing `size` long that does not change size on the way.
///
/// **Proportional over the room the thing has to move in**, not over the pane:
/// `at / (from - size)` is how far along its own travel the thing is, and that
/// share is what is kept. So a widget flush against the right edge of the
/// laptop is flush against the right edge of the monitor, one in the middle is
/// in the middle, and anything that fitted on the first pane fits on the
/// second without the clamp having to touch it. A share of the *pane* would
/// keep the top-left corner's share instead, and everything near the far edges
/// would drift inwards by its own size times the growth — the clock in the
/// corner a few hundred pixels off it, which is exactly "not the same glass".
///
/// Nothing is done for a thing that does not fit one of the two panes: there is
/// no travel to keep a share of, and the clamp in `glassAt` already puts the
/// head of it on the pane, which is all the room there is. That keeps the map
/// invertible — laptop to monitor and back gives back the pixels you left —
/// which is the property every other choice here is in service of.
pub(crate) fn travel(at: f64, size: f64, from: f64, to: f64) -> f64 {
    let size = if size.is_finite() && size > 0.0 { size } else { 0.0 };
    let (was, now) = (from - size, to - size);
    if !(at.is_finite() && was.is_finite() && now.is_finite()) || was < 1.0 || now < 1.0 {
        return at;
    }
    at * now / was
}

/// A frame anybody could have measured: two finite, positive lengths.
fn sane(f: [f64; 2]) -> bool {
    f.iter().all(|v| v.is_finite() && *v > 0.0)
}

/// Two nullable columns as one frame, or none — the `spotOf` bargain: half a
/// frame is not a frame.
fn pair(w: Option<f64>, h: Option<f64>) -> Option<[f64; 2]> {
    let f = [w?, h?];
    sane(f).then_some(f)
}

/// What one thing is drawn at, or nothing known — in which case it is carried
/// as a point, which keeps its top-left's share of the pane.
fn size_of(sizes: Option<&Sizes>, kind: &str, id: &str) -> [f64; 2] {
    sizes
        .and_then(|m| m.get(kind))
        .and_then(|k| k.get(id).or_else(|| k.get("*")))
        .copied()
        .unwrap_or([0.0, 0.0])
}

/// Carry every spot of one room from the pane it was laid out in to another.
///
/// Over the table rather than over `KINDS`, so a card on another wall moves with
/// everything else, as it does under `rescale`. Nothing at all for two frames
/// no screen could tell apart — a pane measured a hair differently on the same
/// screen must not creep every spot.
fn reframe(
    conn: &Connection,
    key: &str,
    from: [f64; 2],
    to: [f64; 2],
    sizes: Option<&Sizes>,
) -> Result<(), String> {
    if !sane(from) || !sane(to) || ((from[0] - to[0]).abs() < 0.5 && (from[1] - to[1]).abs() < 0.5) {
        return Ok(());
    }
    let rows: Vec<(String, String, f64, f64)> = {
        let mut q = conn
            .prepare("SELECT kind, ref, x, y FROM glass_spot WHERE arrangement = ?1")
            .map_err(|e| e.to_string())?;
        let rows = q
            .query_map(params![key], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?
    };
    let mut up = conn
        .prepare(
            "UPDATE glass_spot SET x = ?4, y = ?5 WHERE arrangement = ?1 AND kind = ?2 AND ref = ?3",
        )
        .map_err(|e| e.to_string())?;
    for (kind, id, x, y) in rows {
        let [w, h] = size_of(sizes, &kind, &id);
        up.execute(params![
            key,
            kind,
            id,
            travel(x, w, from[0], to[0]),
            travel(y, h, from[1], to[1])
        ])
        .map_err(|e| format!("reframe {kind} {id}: {e}"))?;
    }
    Ok(())
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
            CREATE TABLE territory (id TEXT PRIMARY KEY, glass_x REAL, glass_y REAL);
            CREATE TABLE reference_image (id TEXT PRIMARY KEY, glass_x REAL, glass_y REAL);
            CREATE TABLE widget (id TEXT PRIMARY KEY, glass_x REAL, glass_y REAL);
            CREATE TABLE timeline (id TEXT PRIMARY KEY, glass_x REAL, glass_y REAL);
            CREATE TABLE arrangement (
                key          TEXT PRIMARY KEY,
                screens_json TEXT NOT NULL,
                seen_at      INTEGER NOT NULL,
                current      INTEGER NOT NULL DEFAULT 0,
                origin_x     REAL NOT NULL DEFAULT 0,
                origin_y     REAL NOT NULL DEFAULT 0,
                unit         REAL,
                frame_w      REAL,
                frame_h      REAL
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
        adopt_in(&conn, "one", "[]", [0.0, 0.0], None, None).unwrap();
        assert_eq!(card_spot(&conn, "c1"), Some((10.0, 20.0)));
        assert_eq!(card_spot(&conn, "c2"), None);
        assert_eq!(spots_in(&conn, "one").unwrap().cards.len(), 1);
    }

    #[test]
    fn a_new_arrangement_is_duplicated_from_the_one_it_was_told_to_copy() {
        let conn = db();
        conn.execute("INSERT INTO placement VALUES ('c1', 10.0, 20.0)", [])
            .unwrap();
        adopt_in(&conn, "one", "[]", [0.0, 0.0], None, None).unwrap();
        adopt_in(&conn, "two", "[]", [0.0, 0.0], None, Some("one")).unwrap();
        assert_eq!(card_spot(&conn, "c1"), Some((10.0, 20.0)));
        // And the two are now separate rooms.
        stick(&conn, "c1", Some(99.0), Some(98.0));
        adopt_in(&conn, "one", "[]", [0.0, 0.0], None, None).unwrap();
        assert_eq!(card_spot(&conn, "c1"), Some((10.0, 20.0)));
        adopt_in(&conn, "two", "[]", [0.0, 0.0], None, None).unwrap();
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
        adopt_in(&conn, "one", "[]", [0.0, 0.0], None, None).unwrap();
        adopt_in(&conn, "two", "[]", [0.0, 0.0], None, Some("one")).unwrap();
        stick(&conn, "c1", None, None);
        adopt_in(&conn, "one", "[]", [0.0, 0.0], None, None).unwrap();
        adopt_in(&conn, "two", "[]", [0.0, 0.0], None, Some("one")).unwrap();
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
        adopt_in(&conn, "one", "[]", [0.0, 0.0], None, None).unwrap();
        adopt_in(&conn, "two", "[]", [0.0, 0.0], None, Some("one")).unwrap();
        stick(&conn, "c1", Some(5.0), Some(6.0));
        assert_eq!(card_spot(&conn, "c1"), Some((5.0, 6.0)));
        adopt_in(&conn, "one", "[]", [0.0, 0.0], None, None).unwrap();
        assert_eq!(card_spot(&conn, "c1"), None);
    }

    #[test]
    fn every_kind_on_the_glass_is_carried() {
        // One list drives the seed and the reconcile, so a sixth thing on the
        // glass cannot be half-done — this is the assertion that says so.
        let conn = db();
        conn.execute("INSERT INTO placement VALUES ('c', 1.0, 2.0)", []).unwrap();
        conn.execute("INSERT INTO territory VALUES ('t1', 3.0, 4.0)", []).unwrap();
        conn.execute("INSERT INTO reference_image VALUES ('i', 5.0, 6.0)", []).unwrap();
        conn.execute("INSERT INTO widget VALUES ('w', 7.0, 8.0)", []).unwrap();
        conn.execute("INSERT INTO timeline VALUES ('t', 9.0, 10.0)", []).unwrap();
        adopt_in(&conn, "one", "[]", [0.0, 0.0], None, None).unwrap();
        let s = spots_in(&conn, "one").unwrap();
        assert_eq!(s.cards.get("c"), Some(&[1.0, 2.0]));
        assert_eq!(s.territories.get("t1"), Some(&[3.0, 4.0]));
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
        adopt_in(&conn, "one", "[]", [0.0, 0.0], None, Some("one")).unwrap();
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
        adopt_in(&conn, "one", "[]", [0.0, 0.0], None, None).unwrap();
        // Spreading: the home screen now starts 1080 across and 60 down.
        adopt_in(&conn, "wide", "[]", [1080.0, 60.0], None, Some("one")).unwrap();
        assert_eq!(card_spot(&conn, "c1"), Some((1180.0, 110.0)));
        // And back: the same place on the home screen again.
        adopt_in(&conn, "one", "[]", [0.0, 0.0], None, None).unwrap();
        assert_eq!(card_spot(&conn, "c1"), Some((100.0, 50.0)));
    }

    #[test]
    fn a_card_on_another_wall_is_remembered_per_room_and_copied_shifted() {
        let conn = db();
        adopt_in(&conn, "one", "[]", [0.0, 0.0], None, None).unwrap();
        remember(&conn, SHADOW, "elsewhere:lab:1", Some(100.0), Some(100.0)).unwrap();
        // A room never seen copies the one just left, shifted by the origins.
        adopt_in(&conn, "spread", "[]", [1920.0, 40.0], None, Some("one")).unwrap();
        let s = spots_in(&conn, "spread").unwrap();
        assert_eq!(s.shadows.get("elsewhere:lab:1"), Some(&[2020.0, 140.0]));
        // It is its own kind: it never lands among the timelines.
        assert!(s.timelines.is_empty());
        // And it is the room's own from here on.
        remember(&conn, SHADOW, "elsewhere:lab:1", Some(3000.0), Some(500.0)).unwrap();
        adopt_in(&conn, "one", "[]", [0.0, 0.0], None, None).unwrap();
        assert_eq!(spots_in(&conn, "one").unwrap().shadows.get("elsewhere:lab:1"), Some(&[100.0, 100.0]));
    }

    #[test]
    fn a_wall_prunes_only_its_own_closed_cards_in_every_room() {
        let conn = db();
        adopt_in(&conn, "one", "[]", [0.0, 0.0], None, None).unwrap();
        remember(&conn, SHADOW, "elsewhere:lab:1", Some(1.0), Some(1.0)).unwrap();
        remember(&conn, SHADOW, "elsewhere:lab:2", Some(2.0), Some(2.0)).unwrap();
        remember(&conn, SHADOW, "elsewhere:lab_x:9", Some(3.0), Some(3.0)).unwrap();
        adopt_in(&conn, "two", "[]", [0.0, 0.0], None, Some("one")).unwrap();
        // lab says card 2 is all it has. `_` in a host is not a wildcard.
        assert_eq!(keep_shadows(&conn, "lab", &["elsewhere:lab:2".to_string()]).unwrap(), 1);
        for room in ["one", "two"] {
            let s = spots_in(&conn, room).unwrap().shadows;
            assert!(!s.contains_key("elsewhere:lab:1"), "{room}");
            assert!(s.contains_key("elsewhere:lab:2"), "{room}");
            assert!(s.contains_key("elsewhere:lab_x:9"), "{room}");
        }
    }

    #[test]
    fn a_thing_that_is_gone_leaves_every_room() {
        /* A spot outlives the thing it was for unless something takes it off
           every arrangement, not only the one in front of you. The territory
           ids this is keyed on are uuids and are never reused, so what this
           guards now is a row nobody can name again rather than one that finds
           a new owner — which was the sharper failure while a region's ref was
           its `root_path`. */
        let conn = db();
        conn.execute("INSERT INTO territory VALUES ('t1', 3.0, 4.0)", []).unwrap();
        adopt_in(&conn, "one", "[]", [0.0, 0.0], None, None).unwrap();
        adopt_in(&conn, "two", "[]", [0.0, 0.0], None, Some("one")).unwrap();
        forget(&conn, TERRITORY, "t1");
        // Gone from the room it was deleted in, and from the other one too.
        assert!(spots_in(&conn, "two").unwrap().territories.is_empty());
        assert!(spots_in(&conn, "one").unwrap().territories.is_empty());
        // And the folder added back is on the wall, not where the old one was.
        conn.execute("UPDATE territory SET glass_x = NULL, glass_y = NULL", []).unwrap();
        adopt_in(&conn, "one", "[]", [0.0, 0.0], None, None).unwrap();
        let back: Option<f64> = conn
            .query_row("SELECT glass_x FROM territory WHERE id = 't1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(back, None);
    }

    #[test]
    fn an_arrangement_that_cannot_be_read_is_not_treated_as_new() {
        /* `is_err()` conflated "no row" with "could not tell", and the gate it
           guards clones over a room's real spots. */
        let conn = db();
        conn.execute("DROP TABLE arrangement", []).unwrap();
        assert!(adopt_in(&conn, "one", "[]", [0.0, 0.0], None, None).is_err());
    }

    #[test]
    fn only_one_arrangement_is_ever_current() {
        let conn = db();
        adopt_in(&conn, "one", "[]", [0.0, 0.0], None, None).unwrap();
        adopt_in(&conn, "two", "[]", [0.0, 0.0], None, None).unwrap();
        adopt_in(&conn, "three", "[]", [0.0, 0.0], None, None).unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM arrangement WHERE current = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
        assert_eq!(current(&conn).as_deref(), Some("three"));
    }

    #[test]
    fn which_screen_is_home_moves_the_chrome_and_nothing_on_the_glass() {
        /* Lyss's inverted-L: the laptop at 150% beside monitors at 100%. Spread
           from the laptop, the page is zoomed to 1.5; spread from a monitor, to
           1.0. The arrangement is the same desk either way — same key — and a
           spot left 100 CSS pixels in from home 1.5 is 150 physical pixels
           from the window's origin, which from home 1.0 is 150 CSS pixels. */
        let conn = db();
        conn.execute("INSERT INTO placement VALUES ('c1', NULL, NULL)", []).unwrap();
        adopt_in(&conn, "desk", "[]", [0.0, 0.0], Some(1.5), None).unwrap();
        stick(&conn, "c1", Some(100.0), Some(200.0));
        // Unspread, then spread again from the other screen.
        adopt_in(&conn, "one", "[]", [0.0, 0.0], None, Some("desk")).unwrap();
        adopt_in(&conn, "desk", "[]", [0.0, 0.0], Some(1.0), None).unwrap();
        assert_eq!(card_spot(&conn, "c1"), Some((150.0, 300.0)));
        // And from the laptop again: exactly where it was left.
        adopt_in(&conn, "desk", "[]", [0.0, 0.0], Some(1.5), None).unwrap();
        assert_eq!(card_spot(&conn, "c1"), Some((100.0, 200.0)));
    }

    #[test]
    fn a_room_spread_from_a_screen_at_the_same_scale_is_untouched() {
        let conn = db();
        conn.execute("INSERT INTO placement VALUES ('c1', NULL, NULL)", []).unwrap();
        adopt_in(&conn, "desk", "[]", [0.0, 0.0], Some(1.0), None).unwrap();
        stick(&conn, "c1", Some(333.0), Some(17.0));
        adopt_in(&conn, "one", "[]", [0.0, 0.0], None, Some("desk")).unwrap();
        adopt_in(&conn, "desk", "[]", [0.0, 0.0], Some(1.0), None).unwrap();
        assert_eq!(card_spot(&conn, "c1"), Some((333.0, 17.0)));
    }

    #[test]
    fn a_room_with_no_unit_recorded_is_read_as_it_stands() {
        /* Every room stored before v52, and every unspread room. Nothing knows
           what home those spots were laid out under, so they are taken to be in
           the unit they are read in — and that unit is recorded from then on. */
        let conn = db();
        conn.execute("INSERT INTO placement VALUES ('c1', NULL, NULL)", []).unwrap();
        adopt_in(&conn, "desk", "[]", [0.0, 0.0], None, None).unwrap();
        stick(&conn, "c1", Some(40.0), Some(80.0));
        adopt_in(&conn, "one", "[]", [0.0, 0.0], None, Some("desk")).unwrap();
        adopt_in(&conn, "desk", "[]", [0.0, 0.0], Some(1.25), None).unwrap();
        assert_eq!(card_spot(&conn, "c1"), Some((40.0, 80.0)));
        adopt_in(&conn, "one", "[]", [0.0, 0.0], None, None).unwrap();
        adopt_in(&conn, "desk", "[]", [0.0, 0.0], Some(1.0), None).unwrap();
        assert_eq!(card_spot(&conn, "c1"), Some((50.0, 100.0)));
    }

    /// What `Canvas` hands over: a card is one size whichever card it is, and a
    /// widget is its own.
    fn book() -> Sizes {
        let mut card = HashMap::new();
        card.insert("*".to_string(), [300.0, 200.0]);
        let mut widget = HashMap::new();
        widget.insert("w".to_string(), [100.0, 50.0]);
        let mut out = Sizes::new();
        out.insert(CARD.to_string(), card);
        out.insert(WIDGET.to_string(), widget);
        out
    }

    fn framed<'a>(
        frame: Option<[f64; 2]>,
        from: Option<[f64; 2]>,
        clone_from: Option<[f64; 2]>,
        sizes: &'a Sizes,
    ) -> Framing<'a> {
        Framing { frame, from, clone_from, sizes: Some(sizes) }
    }

    fn frame_of(conn: &Connection, key: &str) -> Option<[f64; 2]> {
        known_in(conn).unwrap().into_iter().find(|k| k.key == key).and_then(|k| k.frame)
    }

    const LAPTOP: [f64; 2] = [1280.0, 646.0];
    const MONITOR: [f64; 2] = [2560.0, 1286.0];
    const ROOM: &str = "one landscape screen";

    #[test]
    fn travel_keeps_the_share_of_the_room_a_thing_has_to_move_in() {
        // Flush right on the laptop is flush right on the monitor.
        assert_eq!(travel(1280.0 - 300.0, 300.0, 1280.0, 2560.0), 2560.0 - 300.0);
        // Flush left stays flush left.
        assert_eq!(travel(0.0, 300.0, 1280.0, 2560.0), 0.0);
        // The middle stays the middle: its centre is the pane's centre.
        let x = travel((1280.0 - 300.0) / 2.0, 300.0, 1280.0, 2560.0);
        assert_eq!(x + 150.0, 1280.0);
        // And it comes back to the pixel it left.
        assert_eq!(travel(travel(437.0, 300.0, 1280.0, 2560.0), 300.0, 2560.0, 1280.0), 437.0);
        // Nothing known about its size: a point, so the top-left's share.
        assert_eq!(travel(640.0, 0.0, 1280.0, 2560.0), 1280.0);
        // Too big for one of the two panes: no travel to keep, so left alone —
        // and left alone both ways, which keeps the round trip whole.
        assert_eq!(travel(10.0, 1400.0, 1280.0, 2560.0), 10.0);
        assert_eq!(travel(10.0, 1400.0, 2560.0, 1280.0), 10.0);
        assert_eq!(travel(f64::NAN, 0.0, 1280.0, 2560.0).is_nan(), true);
        assert_eq!(travel(5.0, 0.0, 0.0, 2560.0), 5.0);
    }

    #[test]
    fn the_laptop_glass_on_the_monitor_is_the_same_glass_scaled() {
        /* Lyss, 2026-10-15: "it should be identical but scaled to match". A
           card flush in the laptop's top-right corner and a widget in the
           middle are still in the corner and the middle on a monitor twice the
           size — and they are still the size they were. */
        let conn = db();
        let sizes = book();
        conn.execute("INSERT INTO placement VALUES ('c1', NULL, NULL)", []).unwrap();
        conn.execute("INSERT INTO widget VALUES ('w', NULL, NULL)", []).unwrap();
        adopt_framed(&conn, ROOM, "[]", [0.0, 0.0], None, None, &framed(Some(LAPTOP), None, None, &sizes))
            .unwrap();
        stick(&conn, "c1", Some(1280.0 - 300.0), Some(0.0));
        conn.execute("UPDATE widget SET glass_x = 590.0, glass_y = 298.0", []).unwrap();
        note(&conn, WIDGET, "w", Some(590.0), Some(298.0));

        // The same room, on the monitor.
        adopt_framed(
            &conn,
            ROOM,
            "[]",
            [0.0, 0.0],
            None,
            None,
            &framed(Some(MONITOR), Some(LAPTOP), None, &sizes),
        )
        .unwrap();
        assert_eq!(card_spot(&conn, "c1"), Some((2560.0 - 300.0, 0.0)));
        let w = spots_in(&conn, ROOM).unwrap().widgets["w"];
        assert_eq!([w[0] + 50.0, w[1] + 25.0], [1280.0, 643.0], "the middle is the middle");
        assert_eq!(frame_of(&conn, ROOM), Some(MONITOR));

        // And back on the laptop, exactly where it was left.
        adopt_framed(
            &conn,
            ROOM,
            "[]",
            [0.0, 0.0],
            None,
            None,
            &framed(Some(LAPTOP), Some(MONITOR), None, &sizes),
        )
        .unwrap();
        assert_eq!(card_spot(&conn, "c1"), Some((980.0, 0.0)));
        assert_eq!(spots_in(&conn, ROOM).unwrap().widgets["w"], [590.0, 298.0]);
    }

    #[test]
    fn a_card_on_another_wall_is_carried_with_everything_else() {
        let conn = db();
        let sizes = book();
        adopt_framed(&conn, ROOM, "[]", [0.0, 0.0], None, None, &framed(Some(LAPTOP), None, None, &sizes))
            .unwrap();
        remember(&conn, SHADOW, "elsewhere:lab:1", Some(640.0), Some(323.0)).unwrap();
        adopt_framed(
            &conn,
            ROOM,
            "[]",
            [0.0, 0.0],
            None,
            None,
            &framed(Some(MONITOR), Some(LAPTOP), None, &sizes),
        )
        .unwrap();
        // No size in the book for a shadow here, so it travels as a point.
        assert_eq!(spots_in(&conn, ROOM).unwrap().shadows["elsewhere:lab:1"], [1280.0, 643.0]);
    }

    #[test]
    fn the_same_screen_moves_nothing_and_no_frame_erases_none() {
        let conn = db();
        let sizes = book();
        conn.execute("INSERT INTO placement VALUES ('c1', NULL, NULL)", []).unwrap();
        adopt_framed(&conn, ROOM, "[]", [0.0, 0.0], None, None, &framed(Some(LAPTOP), None, None, &sizes))
            .unwrap();
        stick(&conn, "c1", Some(123.0), Some(45.0));
        // Back on the same screen with the pane measured a little short (a
        // draft open in the dock): no `from`, so nothing moves — and the frame
        // the spots were laid out in is what is kept.
        adopt_framed(&conn, ROOM, "[]", [0.0, 0.0], None, None, &framed(None, None, None, &sizes)).unwrap();
        assert_eq!(card_spot(&conn, "c1"), Some((123.0, 45.0)));
        assert_eq!(frame_of(&conn, ROOM), Some(LAPTOP));
        // A frame a hair off the recorded one is not a different screen.
        adopt_framed(
            &conn,
            ROOM,
            "[]",
            [0.0, 0.0],
            None,
            None,
            &framed(Some([1280.2, 646.3]), Some(LAPTOP), None, &sizes),
        )
        .unwrap();
        assert_eq!(card_spot(&conn, "c1"), Some((123.0, 45.0)));
        // A nonsense frame is no frame.
        adopt_framed(
            &conn,
            ROOM,
            "[]",
            [0.0, 0.0],
            None,
            None,
            &framed(Some([0.0, 646.0]), Some(LAPTOP), None, &sizes),
        )
        .unwrap();
        assert_eq!(card_spot(&conn, "c1"), Some((123.0, 45.0)));
        assert_eq!(frame_of(&conn, ROOM), Some([1280.2, 646.3]));
    }

    #[test]
    fn flipping_between_scaled_and_per_size_loses_neither() {
        /* The toggle selects a room; it never converts one into the other. A
           first flip copies the scaled room on this very screen, so nothing
           moves; what is then arranged per size stays per size; and the scaled
           glass is found as it was left. */
        let conn = db();
        let sizes = book();
        let per_size = "one screen 1920x1200@1.50";
        conn.execute("INSERT INTO placement VALUES ('c1', NULL, NULL)", []).unwrap();
        adopt_framed(&conn, ROOM, "[]", [0.0, 0.0], None, None, &framed(Some(LAPTOP), None, None, &sizes))
            .unwrap();
        stick(&conn, "c1", Some(100.0), Some(50.0));

        // To per-size, on the same screen: copied, and not reframed.
        adopt_framed(
            &conn,
            per_size,
            "[]",
            [0.0, 0.0],
            None,
            Some(ROOM),
            &framed(Some([1280.0, 640.0]), None, None, &sizes),
        )
        .unwrap();
        assert_eq!(card_spot(&conn, "c1"), Some((100.0, 50.0)));
        stick(&conn, "c1", Some(700.0), Some(300.0));

        // Back to scaled: as it was.
        adopt_framed(&conn, ROOM, "[]", [0.0, 0.0], None, None, &framed(Some(LAPTOP), None, None, &sizes))
            .unwrap();
        assert_eq!(card_spot(&conn, "c1"), Some((100.0, 50.0)));
        // And per-size again: what was arranged there.
        adopt_framed(&conn, per_size, "[]", [0.0, 0.0], None, None, &framed(None, None, None, &sizes)).unwrap();
        assert_eq!(card_spot(&conn, "c1"), Some((700.0, 300.0)));
    }

    #[test]
    fn a_copy_of_a_room_from_another_screen_size_arrives_scaled() {
        // Per-size, on a monitor never seen: the nearest room was laid out on
        // the laptop, so the copy is that glass scaled to this screen.
        let conn = db();
        let sizes = book();
        conn.execute("INSERT INTO placement VALUES ('c1', NULL, NULL)", []).unwrap();
        adopt_framed(&conn, "laptop", "[]", [0.0, 0.0], None, None, &framed(Some(LAPTOP), None, None, &sizes))
            .unwrap();
        stick(&conn, "c1", Some(980.0), Some(446.0));
        adopt_framed(
            &conn,
            "monitor",
            "[]",
            [0.0, 0.0],
            None,
            Some("laptop"),
            &framed(Some(MONITOR), None, Some(LAPTOP), &sizes),
        )
        .unwrap();
        assert_eq!(card_spot(&conn, "c1"), Some((2260.0, 1086.0)), "the bottom-right corner");
        // And the laptop's own room is untouched by the copy.
        adopt_framed(&conn, "laptop", "[]", [0.0, 0.0], None, None, &framed(None, None, None, &sizes)).unwrap();
        assert_eq!(card_spot(&conn, "c1"), Some((980.0, 446.0)));
    }

    #[test]
    fn rescale_says_nothing_it_cannot_stand_behind() {
        assert_eq!(rescale(Some(1.5), Some(1.0)), Some(1.5));
        assert_eq!(rescale(Some(1.0), Some(2.0)), Some(0.5));
        assert_eq!(rescale(None, Some(1.0)), None);
        assert_eq!(rescale(Some(1.0), None), None);
        assert_eq!(rescale(Some(1.5), Some(1.5)), None);
        // A float that came back a hair different must not creep every spot.
        assert_eq!(rescale(Some(1.5), Some(1.5 + 1e-9)), None);
        assert_eq!(rescale(Some(0.0), Some(1.0)), None);
        assert_eq!(rescale(Some(f64::NAN), Some(1.0)), None);
    }
}
