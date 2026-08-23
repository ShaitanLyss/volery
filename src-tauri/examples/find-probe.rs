//! Does the finder actually find things, and how long does it take?
//!
//!     cargo run --example find-probe -- .. "off_main"
//!     cargo run --example find-probe -- C:\Caravan "FRailReplay"
//!
//! The counterpart to `azdo-probe`, pointed at ripgrep instead of at a service:
//! it drives `find::list_files`, `find::grep` and `find::read_text` — the same
//! functions the three Tauri commands are thin `off_main` wrappers over —
//! against a real tree, and prints what came back and what it cost.
//!
//! It exists because the two numbers the panel's whole design rests on cannot be
//! assumed, and both are per-tree:
//!
//! 1. **What does `rg --files` cost?** Files mode fetches the list once per open
//!    and fuzzy-filters it in the front end, which is the entire reason typing
//!    feels instant. That trade is only right while this number is small — if a
//!    tree takes four seconds to walk, the panel wants a different shape.
//!
//! 2. **Does a query come back bounded?** `HIT_CAP` kills the child rather than
//!    draining it, so a one-character query has to return in about the time a
//!    precise one does. If it does not, the cap is not doing its job and typing
//!    the first letter of a word stalls the panel.
//!
//! Nothing here is a test — it walks whatever tree it is pointed at and depends
//! on a ripgrep being installed, so it is run by hand and its findings are
//! written into the comments that depend on them.

fn main() {
    let mut args = std::env::args().skip(1);
    let root = args.next().unwrap_or_else(|| {
        eprintln!("usage: cargo run --example find-probe -- <project root> [query]");
        std::process::exit(2);
    });
    let query = args.next().unwrap_or_else(|| "fn ".to_string());

    println!("root       {root}");

    let t0 = std::time::Instant::now();
    let list = match skein_lib::find::list_files(&root) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("\nlist_files failed: {e}");
            std::process::exit(1);
        }
    };
    let files_ms = t0.elapsed().as_millis();
    let files = serde_json::to_value(&list).unwrap();
    let paths = files["files"].as_array().unwrap();
    println!(
        "\nrg --files in {files_ms}ms — {} paths, truncated {}",
        paths.len(),
        files["truncated"]
    );
    for p in paths.iter().take(5) {
        println!("           {}", p.as_str().unwrap());
    }
    if paths.iter().any(|p| p.as_str().unwrap().contains("/.git/")) {
        println!("  ! a .git object got through the glob");
    }

    /* The precise query, then a one-character one — the pair is the point. The
       second is what `HIT_CAP` exists for, and the two timings side by side are
       the only way to see whether the cap is doing anything. */
    for q in [query.as_str(), "e"] {
        let t = std::time::Instant::now();
        match skein_lib::find::grep(&root, q) {
            Ok(hits) => {
                let v = serde_json::to_value(&hits).unwrap();
                let rows = v["hits"].as_array().unwrap();
                println!(
                    "\ngrep {q:?} in {}ms — {} hits, truncated {}, literal {}",
                    t.elapsed().as_millis(),
                    rows.len(),
                    v["truncated"],
                    v["literal"],
                );
                for h in rows.iter().take(3) {
                    println!(
                        "           {}:{}:{}  {}",
                        h["path"].as_str().unwrap(),
                        h["line"],
                        h["col"],
                        h["text"].as_str().unwrap(),
                    );
                }
            }
            Err(e) => println!("\ngrep {q:?} failed: {e}"),
        }
    }

    /* A pattern ripgrep refuses, which is the fallback this exists to prove:
       `literal` must come back true with hits rather than an empty answer. */
    let t = std::time::Instant::now();
    match skein_lib::find::grep(&root, "fn (") {
        Ok(hits) => {
            let v = serde_json::to_value(&hits).unwrap();
            println!(
                "\ngrep \"fn (\" in {}ms — {} hits, literal {}  (an invalid regex, so this is the fallback)",
                t.elapsed().as_millis(),
                v["hits"].as_array().unwrap().len(),
                v["literal"],
            );
        }
        Err(e) => println!("\nthe literal fallback failed: {e}"),
    }

    /* And reading one, including the two guards that only fire on real files. */
    if let Some(first) = paths.first().and_then(|p| p.as_str()) {
        match skein_lib::find::read_text(&root, first) {
            Ok(text) => {
                let v = serde_json::to_value(&text).unwrap();
                println!(
                    "\nread {first} — {} bytes, binary {}, truncated {}, {} chars read",
                    v["bytes"],
                    v["binary"],
                    v["truncated"],
                    v["text"].as_str().unwrap().chars().count(),
                );
            }
            Err(e) => println!("\nread {first} failed: {e}"),
        }
    }

    /* The guard that can never fire from the panel, which is why it is worth
       seeing fire at least once. */
    match skein_lib::find::read_text(&root, "../../../Windows/win.ini") {
        Ok(_) => println!("\n! safe_join let a path out of the project"),
        Err(e) => println!("\nsafe_join refused a climb out: {e}"),
    }
}
