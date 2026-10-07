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

use skein_lib::flyway::link::answer_with;
use skein_lib::flyway::seal::WallKey;
use skein_lib::flyway::session::Msg;
use skein_lib::flyway::wire::Wire;
use skein_lib::store::Store;

/// Both ends share this. In life it comes out of the credential vault; here it
/// stands for "the two machines have been given the same invite".
const KEY: [u8; 32] = [42u8; 32];

/// Drop a finding on a wall the way the sink really does: the event is recorded
/// in the same breath as the row, which is what `sinksync::record` is for.
fn plant(store: &Store, host: &str, id: &str, title: &str, at: i64) {
    /* `sinksync::emit` stamps an event with `key::host_name()`, which is a fact
       about the *process* — so two walls simulated in one process record under
       one name unless it is switched here, their seqs collide, and each one's
       watermark already covers the other's events. That is exactly what this
       example caught on its first run: a clean connection carrying nothing.
    
       Switched around the write rather than held, because it is only `emit`
       that reads it and the writes are sequential. On two real machines the
       variable is unset and `COMPUTERNAME` answers, which is the whole point. */
    std::env::set_var("VOLERY_FLYWAY_HOST", host);
    let conn = store.0.lock().unwrap();
    /* The *real* write, not a hand-built event. `put_sink_item` is what every
       drop goes through, and it records the event in the same savepoint as the
       row — which is the half this example exists to exercise. Building the
       event by hand tested the wire and quietly skipped the row. */
    skein_lib::store::put_sink_item(&conn, id, None, "bug", title, "seen while linking", "", Some("card"))
        .expect("drop a finding");
    let _ = at;
    drop(conn);
    std::env::remove_var("VOLERY_FLYWAY_HOST");
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

    /* **Two real stores**, because the thing nobody had run is the integrated
       path: a sink write landing in an outbox, that outbox answering a
       watermark, and an arriving event folding into real rows. Everything in
       between had tests; the sequence had none. */
    let root = std::env::temp_dir().join(format!("flyway-link-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let desk_dir = root.join("desk");
    let lap_dir = root.join("laptop");
    std::fs::create_dir_all(&desk_dir).unwrap();
    std::fs::create_dir_all(&lap_dir).unwrap();
    let desk_store = Store::open(desk_dir).expect("desk store");
    let lap_store = Store::open(lap_dir).expect("laptop store");

    /* Each wall drops a finding of its own. `record` is what every sink write
       calls, so this is the real local path rather than a hand-built event. */
    plant(&desk_store, "desk", "a", "the ring pegs at 100%", 10);
    plant(&lap_store, "laptop", "b", "the dock eats a keystroke", 20);

    /* The desk listens; the laptop dials.

       One exchange is one-directional for events, and that is enough to prove
       the link: the laptop says hello with its watermark, the desk answers with
       its own hello and everything the laptop is missing. In life the desk
       learns the laptop's side when *it* dials, which is `link.rs`'s whole
       "both walls pull, nobody pushes" arrangement. */
    let serving = tokio::spawn(async move {
        desk.serve_one(|heard| {
            let conn = desk_store.0.lock().unwrap();
            answer_with(&conn, heard)
        })
        .await
    });

    println!("laptop dialling the desk …");
    let hello = {
        let conn = lap_store.0.lock().unwrap();
        Msg::Hello {
            host: "laptop".into(),
            watermark: skein_lib::sinksync::watermark(&conn).unwrap(),
        }
    };
    let back = match laptop.exchange(guess, vec![hello]).await {
        Ok(b) => b,
        Err(e) => {
            eprintln!("\nthe dial failed: {e}");
            eprintln!("\nIf this is a timeout, the relay or the lookup service could not be");
            eprintln!("reached. That is the same question `flyway-probe` asks, and the answer");
            eprintln!("decides whether this transport can be used from that network at all.");
            std::process::exit(1);
        }
    };
    let mut news = 0;
    {
        let conn = lap_store.0.lock().unwrap();
        for m in back {
            if let Msg::Events { events } = m {
                for e in &events {
                    if skein_lib::sinksync::receive(&conn, e).unwrap_or(false) {
                        news += 1;
                    }
                }
            }
        }
    }
    println!("  {news} event(s) were news to the laptop");

    let _ = serving.await;

    let conn = lap_store.0.lock().unwrap();
    let titles: Vec<String> = {
        let mut stmt = conn.prepare("SELECT title FROM sink_item ORDER BY title").unwrap();
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        rows
    };
    println!("\nthe laptop now holds:");
    for t in &titles {
        println!("  · {t}");
    }

    println!("\n=== what this run established ===");
    if titles.len() == 2 {
        println!("Two walls holding one key found each other by name, opened a sealed");
        println!("connection, and a finding dropped on one is now a row in the other's");
        println!("sink — through the real outbox, the real watermark and the real fold.");
        println!("\nWhat it does NOT establish, and only two machines can: NAT traversal");
        println!("between separate networks, and whether an intercepting gateway lets the");
        println!("relay through. See docs/FLYWAY-PROBE.md.");
    } else {
        println!("The link opened but the piles did not converge — {} item(s), expected 2.", titles.len());
        println!("That is a `session.rs` question rather than a transport one.");
        std::process::exit(1);
    }
}
