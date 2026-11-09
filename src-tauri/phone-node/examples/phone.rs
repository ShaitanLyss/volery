//! M2a's proof: a phone node dials a wall and prints the roster and digest it
//! read back.
//!
//! Bring up a lab wall first (`bun run lab m2`), then read its key and host
//! name out of the credential vault (`dev.skein.lab.m2/flyway-key`) and pass
//! them here:
//!
//! ```powershell
//! cd src-tauri
//! cargo run -p phone-node --example phone -- "<key-phrase>" "<wall-host>" [phone-name]
//! ```
//!
//! The wall host for a lab named `m2` is `lab-m2.<COMPUTERNAME>` — the name
//! `bun run lab` gives it (`tools/lab.ts`), which is also the name stored after
//! the `·` in the vault entry. The phone name defaults to `phone`.
//!
//! What proves the milestone: the printed roster contains the node's own name,
//! which is the wall having folded the node in — the phone is *on the roster* —
//! and the printed digest is the wall's cards snapshot.

use flyway_core::seal::WallKey;
use phone_node::Node;

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let usage = "usage: phone <key-phrase> <wall-host> [phone-name]";
    let phrase = args.next().unwrap_or_else(|| die(usage));
    let wall = args.next().unwrap_or_else(|| die(usage));
    let name = args.next().unwrap_or_else(|| "phone".to_string());

    let key = WallKey::from_phrase(&phrase).unwrap_or_else(|e| die(&e));
    let node = Node::start(key, name.clone()).await.unwrap_or_else(|e| die(&e));
    let sight = node.sight(&wall).await.unwrap_or_else(|e| die(&e));

    println!("dialled {wall} as {name}");
    println!("roster — {} wall(s):", sight.roster.len());
    let mut roster = sight.roster.clone();
    roster.sort_by(|a, b| a.wall.host.cmp(&b.wall.host));
    for h in &roster {
        let f = &h.wall.facts;
        let mine = if h.wall.host == name { "  ← this node" } else { "" };
        let build = if f.build.is_empty() { "?" } else { &f.build };
        println!(
            "  {:<40} cards_live {}  working {}  accepting {}  build {}{}",
            h.wall.host, f.cards_live, f.cards_working, f.accepting, build, mine
        );
    }
    match &sight.cards {
        Some(d) => {
            println!("cards digest from {} (version {}, {}ms old):", d.host, d.version, d.age_ms);
            println!("{}", serde_json::to_string_pretty(&d.snapshot).unwrap_or_default());
        }
        None => println!(
            "{wall} published no cards digest — its wall may still be painting itself; dial again in a moment"
        ),
    }
}

fn die(why: &str) -> ! {
    eprintln!("{why}");
    std::process::exit(1);
}
