//! Walk a *copy* of a real wall up to this build's schema, and say what
//! happened to it.
//!
//! Unit tests build their fixtures, so they only ever meet the rows somebody
//! thought to write. A wall that has been open for months has the rows nobody
//! thought of: territories under junction paths, cards closed a fortnight ago,
//! glass spots in three screen arrangements, projects that point nowhere. A
//! migration is exactly the kind of change whose failures live in that gap.
//!
//! ```powershell
//! # never the real file — see below
//! cd src-tauri && cargo run --example migrate-check -- C:\path\to\a\copy
//! ```
//!
//! **It takes a directory and refuses the installed wall's own.** `store.rs`
//! already refuses to carry the installed wall's schema forward from a debug
//! build (`may_migrate`), because doing so leaves the installed app refusing
//! its own database until it is rebuilt — that cost a wall of 86 cards a
//! hand-edited `user_version` on 2026-09-07. This refuses a second time and
//! earlier, with the copy instruction in the message, because the whole point
//! of this tool is to be pointed at real data and the obvious path to type is
//! the dangerous one.
//!
//! What it prints is a before-and-after of the things a migration can quietly
//! lose: the row counts, and then one line per invariant the new schema is
//! supposed to establish. Nothing here is a substitute for the unit tests; it
//! is the half they cannot reach.

use std::path::PathBuf;

fn main() {
    let Some(arg) = std::env::args().nth(1) else {
        eprintln!("usage: cargo run --example migrate-check -- <dir holding a COPY of skein.db>");
        std::process::exit(2);
    };
    let dir = PathBuf::from(&arg);

    if !dir.join("skein.db").exists() {
        eprintln!("no skein.db in {}", dir.display());
        std::process::exit(2);
    }
    /* The guard that matters. `%APPDATA%\dev.skein.studio` is the wall the
       installed app opens; migrating it from here is the failure this tool
       would otherwise make easy. */
    if let Ok(appdata) = std::env::var("APPDATA") {
        let live = PathBuf::from(&appdata).join("dev.skein.studio");
        if same_dir(&dir, &live) {
            eprintln!(
                "that is the wall the installed app opens.\n\
                 copy it first:\n  \
                 cp \"{}\\skein.db\" <somewhere>\\skein.db",
                live.display()
            );
            std::process::exit(2);
        }
    }

    let before = facts(&dir);
    println!("before — schema v{}", before.version);
    before.print();

    println!("\nmigrating …");
    match skein_lib::store::Store::open(dir.clone()) {
        Ok(_) => println!("  ok"),
        Err(e) => {
            eprintln!("  REFUSED: {e}");
            std::process::exit(1);
        }
    }

    let after = facts(&dir);
    println!("\nafter — schema v{}", after.version);
    after.print();

    println!("\n=== what survived ===");
    let mut bad = 0;
    let mut check = |ok: bool, what: &str| {
        println!("  {} {what}", if ok { "ok  " } else { "LOST" });
        if !ok {
            bad += 1;
        }
    };

    /* Nothing may be lost. A migration that drops a card drops a conversation,
       and the only thing worse than that is doing it quietly. */
    check(after.projects == before.projects, "every project is still here");
    check(after.convs == before.convs, "every conversation is still here");
    check(after.spots == before.spots, "every glass spot is still here");

    /* And the invariants v42–v44 exist to establish. */
    check(
        after.projects_without_territory == 0,
        "every project has somewhere to put its cards",
    );
    check(
        after.convs_without_territory == 0,
        "every card stands in a grouping",
    );
    check(
        after.spots_still_project_kind == 0,
        "no glass spot is still keyed on a folder",
    );
    check(
        after.orphan_spots == 0,
        "no glass spot names a territory that is not there",
    );
    check(
        after.sink_without_origin == 0,
        "every finding says which machine it was seen on",
    );

    if bad == 0 {
        println!("\nThis wall walks up cleanly.");
    } else {
        println!("\n{bad} thing(s) did not survive. Do not ship this.");
        std::process::exit(1);
    }
}

fn same_dir(a: &PathBuf, b: &PathBuf) -> bool {
    let norm = |p: &PathBuf| {
        std::fs::canonicalize(p)
            .unwrap_or_else(|_| p.clone())
            .to_string_lossy()
            .to_lowercase()
    };
    norm(a) == norm(b)
}

#[derive(Default)]
struct Facts {
    version: i64,
    projects: i64,
    convs: i64,
    spots: i64,
    territories: i64,
    projects_without_territory: i64,
    convs_without_territory: i64,
    spots_still_project_kind: i64,
    orphan_spots: i64,
    sink_without_origin: i64,
}

impl Facts {
    fn print(&self) {
        println!("  projects ....... {}", self.projects);
        println!("  conversations .. {}", self.convs);
        println!("  territories .... {}", self.territories);
        println!("  glass spots .... {}", self.spots);
    }
}

/// Read straight through `rusqlite` rather than through the store's own API —
/// what is being checked is the file, and asking the code under test to
/// describe its own work is how a check passes by agreeing with itself.
fn facts(dir: &PathBuf) -> Facts {
    let conn = match rusqlite::Connection::open(dir.join("skein.db")) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("could not open the copy: {e}");
            std::process::exit(1);
        }
    };
    let one = |sql: &str| -> i64 {
        conn.query_row(sql, [], |r| r.get(0)).unwrap_or(-1)
    };
    Facts {
        version: one("PRAGMA user_version"),
        projects: one("SELECT COUNT(*) FROM project"),
        convs: one("SELECT COUNT(*) FROM conversation"),
        spots: one("SELECT COUNT(*) FROM glass_spot"),
        territories: one("SELECT COUNT(*) FROM territory"),
        projects_without_territory: one(
            "SELECT COUNT(*) FROM project p
              WHERE NOT EXISTS (SELECT 1 FROM territory t WHERE t.project_id = p.id)",
        ),
        convs_without_territory: one("SELECT COUNT(*) FROM conversation WHERE territory_id IS NULL"),
        spots_still_project_kind: one("SELECT COUNT(*) FROM glass_spot WHERE kind = 'project'"),
        orphan_spots: one(
            "SELECT COUNT(*) FROM glass_spot g
              WHERE g.kind = 'territory'
                AND NOT EXISTS (SELECT 1 FROM territory t WHERE t.id = g.ref)",
        ),
        sink_without_origin: one("SELECT COUNT(*) FROM sink_item WHERE origin_host IS NULL"),
    }
}
