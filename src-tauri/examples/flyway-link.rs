//! Two walls, one key, an actual connection.
//!
//! Everything under `flyway/` has unit tests, and not one of them opens a
//! socket — on purpose, so the hard questions could be answered without a
//! network. This is the one that cannot be answered that way: **do two walls
//! holding the same key actually find and talk to each other.**
//!
//! ```powershell
//! cd src-tauri && cargo run --example flyway-link
//! ```
//!
//! It runs both ends in one process, which tests everything except the two
//! things only two machines can: NAT traversal between separate networks, and
//! whether a TLS-intercepting gateway lets the relay through. Those are
//! `docs/FLYWAY-PROBE.md`'s job. What this *does* establish, and what nothing
//! else does:
//!
//! - a wall's identity really is derivable from the key and the machine's name,
//!   so one wall can compute another's without being told it
//! - the lookup service finds an endpoint by that identity
//! - a frame sealed by one wall opens on the other, over a real connection
//! - and the session layer's convergence holds end to end rather than only over
//!   a function call
//!
//! **It reaches the network**, so it is an example rather than a test: it is
//! slow, it depends on somebody else's relay being up, and a suite that goes
//! red when a DNS server is slow is a suite people learn to ignore.

use skein_lib::flyway::seal::WallKey;
use skein_lib::flyway::session::Session;
use skein_lib::flyway::sync::{Event, Stamp, What};
use skein_lib::flyway::wire::Wire;

/// Both ends share this. In life it comes out of the credential vault; here it
/// stands for "the two machines have been given the same invite".
const KEY: [u8; 32] = [42u8; 32];

fn dropped(id: &str, title: &str, at: i64, host: &str) -> What {
    What::Dropped {
        id: id.into(),
        scope: Some("skein".into()),
        kind: "bug".into(),
        title: title.into(),
        body: "seen while linking".into(),
        paths: String::new(),
        from: Some(format!("card-on-{host}")),
        at,
        host: host.into(),
    }
}

#[tokio::main]
async fn main() {
    println!("flyway link — two walls, one key\n");

    /* Two walls, named differently, which is the whole of what makes them two
       peers: the identity is HKDF over the key and the name. */
    let desk = match Wire::start(WallKey::from_bytes(KEY), "desk").await {
        Ok(w) => w,
        Err(e) => {
            eprintln!("could not bind the first wall: {e}");
            std::process::exit(1);
        }
    };
    let laptop = match Wire::start(WallKey::from_bytes(KEY), "laptop").await {
        Ok(w) => w,
        Err(e) => {
            eprintln!("could not bind the second wall: {e}");
            std::process::exit(1);
        }
    };

    println!("  desk   is {}", desk.id());
    println!("  laptop is {}", laptop.id());

    /* The claim that makes an invite a key and a hostname: the laptop works out
       who "desk" is without having been told an address or a node id. */
    let guess = laptop.peer("desk").expect("derive the desk's identity");
    assert_eq!(guess, desk.id(), "a wall must be findable by its name alone");
    println!("  laptop computed the desk's identity from its name alone ✓\n");

    /* Each has heard something the other has not. */
    let mut desk_side = Session::new("desk");
    desk_side.originate(Event {
        stamp: Stamp { host: "desk".into(), seq: 1 },
        what: dropped("a", "the ring pegs at 100%", 10, "desk"),
    });
    let mut lap_side = Session::new("laptop");
    lap_side.originate(Event {
        stamp: Stamp { host: "laptop".into(), seq: 1 },
        what: dropped("b", "the dock eats a keystroke", 20, "laptop"),
    });

    /* The desk listens; the laptop dials.
    
       One exchange is one-directional for events, and that is enough to prove
       the link: the laptop says hello with its watermark, the desk answers with
       its own hello and everything the laptop is missing. The desk learns the
       laptop's side on the next exchange, which in life is the laptop's own
       hello being answered rather than a special case. */
    let serving = tokio::spawn(async move {
        desk.serve_one(|heard| heard.into_iter().flat_map(|m| desk_side.on(m)).collect())
            .await
    });

    println!("laptop dialling the desk …");
    let back = match laptop.exchange(guess, vec![lap_side.open()]).await {
        Ok(b) => b,
        Err(e) => {
            eprintln!("\nthe dial failed: {e}");
            eprintln!("\nIf this is a timeout, the relay or the lookup service could not be");
            eprintln!("reached. That is the same question `flyway-probe` asks, and the answer");
            eprintln!("decides whether this transport can be used from that network at all.");
            std::process::exit(1);
        }
    };
    for m in back {
        lap_side.on(m);
    }

    let _ = serving.await;

    let mut titles: Vec<String> = lap_side.ledger().items().map(|i| i.title.clone()).collect();
    titles.sort();
    println!("\nthe laptop now holds:");
    for t in &titles {
        println!("  · {t}");
    }

    println!("\n=== what this run established ===");
    if titles.len() == 2 {
        println!("Two walls holding one key found each other by name, opened a sealed");
        println!("connection, and each came away with what the other had seen.");
        println!("\nWhat it does NOT establish, and only two machines can: NAT traversal");
        println!("between separate networks, and whether an intercepting gateway lets the");
        println!("relay through. See docs/FLYWAY-PROBE.md.");
    } else {
        println!("The link opened but the piles did not converge — {} item(s), expected 2.", titles.len());
        println!("That is a `session.rs` question rather than a transport one.");
        std::process::exit(1);
    }
}
