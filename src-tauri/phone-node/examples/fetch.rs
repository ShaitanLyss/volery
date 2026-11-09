//! M2v's proof: a phone node fetches a picture or a file a card on the wall
//! produced, over the flyway's `seeing` exchange — the same read a person's
//! viewer makes, now from a node that has no wall of its own.
//!
//! Bring up a lab wall first (`bun run lab m2`), open a card in it, put a file
//! there, then read the wall's key and host out of the credential vault
//! (`dev.skein.lab.m2/flyway-key`) and pass them here with the card's id:
//!
//! ```powershell
//! cd src-tauri
//! cargo run -p phone-node --example fetch -- "<key-phrase>" "<wall-host>" "<card-id>" file "<path>" [out-path]
//! cargo run -p phone-node --example fetch -- "<key-phrase>" "<wall-host>" "<card-id>" picture "<path>" [out-path]
//! ```
//!
//! `path` may be relative to that card's directory or absolute; a sent file is
//! just a file at a path on the owning wall, so it fetches the same way. A file
//! is written whole to `out-path` (a temp file by default); a picture prints
//! its name, byte count and pixel size and writes its bytes to `out-path`.

use flyway_core::seal::WallKey;
use phone_node::{Media, Node};

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let usage = "usage: fetch <key-phrase> <wall-host> <card-id> <file|picture> <path> [out-path]";
    let phrase = args.next().unwrap_or_else(|| die(usage));
    let wall = args.next().unwrap_or_else(|| die(usage));
    let card = args.next().unwrap_or_else(|| die(usage));
    let kind = args.next().unwrap_or_else(|| die(usage));
    let path = args.next().unwrap_or_else(|| die(usage));
    let out = args.next().unwrap_or_else(|| {
        std::env::temp_dir()
            .join(format!("skein-fetch-{}.bin", std::process::id()))
            .to_string_lossy()
            .into_owned()
    });

    let key = WallKey::from_phrase(&phrase).unwrap_or_else(|e| die(&e));
    let node = Node::start(key, "phone".to_string()).await.unwrap_or_else(|e| die(&e));
    let want = match kind.as_str() {
        "file" => Media::File { path },
        "picture" => Media::Picture { kept: None, path: Some(path) },
        other => die(&format!("kind is file or picture, not {other}")),
    };
    let got = node.fetch(&wall, &card, want).await.unwrap_or_else(|e| die(&e));

    let bytes = flyway_core::unbase64(&got.data).unwrap_or_else(|| die("the fetched bytes did not decode"));
    std::fs::write(&out, &bytes).unwrap_or_else(|e| die(&e.to_string()));
    match got.size {
        Some((w, h)) => println!("fetched {} — {} bytes, {w}×{h} pixels, on the wall at {}", got.name, got.bytes, got.full),
        None => println!("fetched {} — {} bytes, on the wall at {}", got.name, got.bytes, got.full),
    }
    println!("wrote {out}");
}

fn die(why: &str) -> ! {
    eprintln!("{why}");
    std::process::exit(1);
}
