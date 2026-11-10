//! The command loop's proof, both halves of M5: a phone node hands a spoken
//! transcript to a wall, which runs the steward and returns a validated plan —
//! and, with `--confirm`, the phone sends only the id and the wall carries the
//! plan out.
//!
//! Bring up a lab wall first (`bun run lab m5`), put a territory in it (its
//! cards and projects are what the plan's referents resolve against), and turn
//! its "take work from other walls" switch on (the steward spends a `claude`
//! turn on that wall's account). Then read the wall's key and host out of the
//! credential vault (`dev.skein.lab.m5/flyway-key`) and pass them here:
//!
//! ```powershell
//! cd src-tauri
//! cargo run -p phone-node --example steward -- "<key-phrase>" "<wall-host>" "open a card for the orchard migration"
//! cargo run -p phone-node --example steward -- --confirm "<key-phrase>" "<wall-host>" "open a card for the orchard migration"
//! ```
//!
//! Prints the whole of what `steward.ts::understand` decided — most often
//! `{ "kind": "plan", "plan": { "reads": … } }` — and, with `--confirm`, the
//! carry's outcome: `{ "kind": "done" }` when the wall ran it, else a `why`.

use flyway_core::seal::WallKey;
use phone_node::Node;

#[tokio::main]
async fn main() {
    let usage = "usage: steward [--confirm] <key-phrase> <wall-host> <transcript>";
    let mut confirm = false;
    let mut rest: Vec<String> = Vec::new();
    for a in std::env::args().skip(1) {
        if a == "--confirm" {
            confirm = true;
        } else {
            rest.push(a);
        }
    }
    let mut args = rest.into_iter();
    let phrase = args.next().unwrap_or_else(|| die(usage));
    let wall = args.next().unwrap_or_else(|| die(usage));
    let transcript = args.collect::<Vec<_>>().join(" ");
    if transcript.is_empty() {
        die(usage);
    }

    let key = WallKey::from_phrase(&phrase).unwrap_or_else(|e| die(&e));
    let node = Node::start(key, "phone".to_string()).await.unwrap_or_else(|e| die(&e));
    let (id, answer) = node.plan(&wall, &transcript).await.unwrap_or_else(|e| die(&e));
    println!("id: {id}");
    println!("{answer:#}");
    if confirm && answer.get("kind").and_then(|k| k.as_str()) == Some("plan") {
        let outcome = node.confirm(&wall, &id).await.unwrap_or_else(|e| die(&e));
        println!("outcome: {outcome:#}");
    }
}

fn die(why: &str) -> ! {
    eprintln!("{why}");
    std::process::exit(1);
}
