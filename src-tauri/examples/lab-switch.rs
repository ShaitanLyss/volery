//! Turn a lab's "take work from other walls" switch on or off, by writing its
//! store directly — for a phone→wall proof that needs the switch on without
//! driving the flyway panel by hand. Uses the same rusqlite the app does, so a
//! WAL-mode store the lab holds open is read and written the way the app's own
//! connection would.
//!
//! ```powershell
//! cd src-tauri
//! cargo run --example lab-switch -- "$env:APPDATA\dev.skein.lab.m5\skein.db" on
//! ```

fn main() {
    let mut args = std::env::args().skip(1);
    let db = args.next().unwrap_or_else(|| {
        eprintln!("usage: lab-switch <skein.db> [on|off]");
        std::process::exit(1);
    });
    let on = args.next().map(|s| s != "off").unwrap_or(true);

    let conn = rusqlite::Connection::open(&db).unwrap_or_else(|e| {
        eprintln!("could not open {db}: {e}");
        std::process::exit(1);
    });
    conn.execute(
        "INSERT INTO flyway_setting (key, value) VALUES ('accepting', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [if on { "1" } else { "0" }],
    )
    .unwrap_or_else(|e| {
        eprintln!("could not write the switch: {e}");
        std::process::exit(1);
    });
    println!("accepting = {}", if on { "on" } else { "off" });
}
