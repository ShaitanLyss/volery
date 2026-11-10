//! M5a's proof: a phone node hands a spoken transcript to a wall, which runs
//! the steward and returns a validated plan — the wall stays the brain.
//!
//! Bring up a lab wall first (`bun run lab m5`), put a territory in it (its
//! cards and projects are what the plan's referents resolve against), and turn
//! its "take work from other walls" switch on (the steward spends a `claude`
//! turn on that wall's account). Then read the wall's key and host out of the
//! credential vault (`dev.skein.lab.m5/flyway-key`) and pass them here:
//!
//! ```powershell
//! cd src-tauri
//! cargo run -p phone-node --example steward -- "<key-phrase>" "<wall-host>" "<transcript>"
//! ```
//!
//! Prints the whole of what `steward.ts::understand` decided — most often
//! `{ "kind": "plan", "plan": { "reads": … } }` — which is the templated
//! confirmation M5's second half speaks back.

use flyway_core::seal::WallKey;
use phone_node::Node;

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let usage = "usage: steward <key-phrase> <wall-host> <transcript>";
    let phrase = args.next().unwrap_or_else(|| die(usage));
    let wall = args.next().unwrap_or_else(|| die(usage));
    let transcript = args.collect::<Vec<_>>().join(" ");
    if transcript.is_empty() {
        die(usage);
    }

    let key = WallKey::from_phrase(&phrase).unwrap_or_else(|e| die(&e));
    let node = Node::start(key, "phone".to_string()).await.unwrap_or_else(|e| die(&e));
    let answer = node.plan(&wall, &transcript).await.unwrap_or_else(|e| die(&e));
    println!("{answer:#}");
}

fn die(why: &str) -> ! {
    eprintln!("{why}");
    std::process::exit(1);
}
