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
//! - **the sink travels both ways from one dial**: the dialler pulls what it
//!   lacks, then pushes what the answer's watermark shows the other wall lacks.
//!   The first version of this example proved one direction and was read as
//!   proving both; the direction it skipped had never once run anywhere.
//! - **an ask crosses and its answer comes back**: the laptop asks the desk to
//!   open a card, the desk's fleet agrees, the desk "opens" it and pushes the
//!   answer, and the laptop's fleet reports it answered — the whole of
//!   `fleet.rs` over a real wire, with the opening itself stood in for, since
//!   that half is the app's `#openIn`.
//!
//! **It reaches the network**, so it is an example rather than a test: it is
//! slow, it depends on somebody else's relay being up, and a suite that goes
//! red when a DNS server is slow is a suite people learn to ignore.

use std::sync::{Arc, Mutex};

use skein_lib::flyway::fleet::{Facts, Fleet, FleetMsg, Outcome, Request, Territory};
use skein_lib::flyway::frame::Frame;
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
fn plant(store: &Store, host: &str, id: &str, title: &str) {
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
    skein_lib::store::put_sink_item(&conn, id, None, "bug", title, "seen while linking", "", Some("card"))
        .expect("drop a finding");
    drop(conn);
    std::env::remove_var("VOLERY_FLYWAY_HOST");
}

fn titles(store: &Store) -> Vec<String> {
    let conn = store.0.lock().unwrap();
    let mut stmt = conn.prepare("SELECT title FROM sink_item ORDER BY title").unwrap();
    let rows = stmt.query_map([], |r| r.get::<_, String>(0)).unwrap().map(Result::unwrap).collect();
    rows
}

fn now() -> i64 {
    skein_lib::store::now()
}

fn skein() -> Territory {
    Territory { identity: "skein".into(), name: "skein".into() }
}

fn facts() -> Facts {
    Facts { territories: vec![skein()], accepting: true, ..Facts::default() }
}

fn fail(what: &str, e: impl std::fmt::Display) -> ! {
    eprintln!("\n{what}: {e}");
    eprintln!("\nIf this is a timeout, the relay or the lookup service could not be");
    eprintln!("reached. That is the same question `flyway-probe` asks, and the answer");
    eprintln!("decides whether this transport can be used from that network at all.");
    std::process::exit(1);
}

#[tokio::main]
async fn main() {
    println!("flyway link — two walls, one key\n");

    /* Two walls, named differently, which is the whole of what makes them two
       peers: the identity is HKDF over the key and the name. */
    let desk = Arc::new(Wire::start(WallKey::from_bytes(KEY), "desk").await.unwrap_or_else(|e| fail("could not bind the first wall", e)));
    let laptop = Wire::start(WallKey::from_bytes(KEY), "laptop").await.unwrap_or_else(|e| fail("could not bind the second wall", e));

    println!("  desk   is {}", desk.id());
    println!("  laptop is {}", laptop.id());

    let guess = laptop.peer("desk").expect("derive the desk's identity");
    assert_eq!(guess, desk.id(), "a wall must be findable by its name alone");
    println!("  laptop computed the desk's identity from its name alone ✓\n");

    /* **Two real stores**, because the thing nobody had run is the integrated
       path: a sink write landing in an outbox, that outbox answering a
       watermark, and an arriving event folding into real rows. */
    let root = std::env::temp_dir().join(format!("flyway-link-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("desk")).unwrap();
    std::fs::create_dir_all(root.join("laptop")).unwrap();
    let desk_store = Arc::new(Store::open(root.join("desk")).expect("desk store"));
    let lap_store = Store::open(root.join("laptop")).expect("laptop store");

    plant(&desk_store, "desk", "a", "the ring pegs at 100%");
    plant(&lap_store, "laptop", "b", "the dock eats a keystroke");

    /* The desk's fleet, and the card it "opens" when asked. In the app this is
       `Link::hear` handing a `Spawn` to the front end and `#openIn`; here it is
       the same fleet calls with the opening stood in for. */
    let desk_fleet = Arc::new(Mutex::new(Fleet::new("desk", 0)));
    desk_fleet.lock().unwrap().announce(facts(), now());

    /* The desk answers whoever dials, as `Link::answer` does: sink frames by
       `answer_with`, fleet frames by its fleet. Three dials are coming. */
    let serving = {
        let desk = desk.clone();
        let store = desk_store.clone();
        let fleet = desk_fleet.clone();
        tokio::spawn(async move {
            for _ in 0..3 {
                let Some(incoming) = desk.next_dial().await else { break };
                let store = store.clone();
                let fleet = fleet.clone();
                let out = desk
                    .answer(incoming, move |heard, _who| async move {
                        let mut out = Vec::new();
                        for f in heard {
                            match f {
                                Frame::Sink(m) => {
                                    let conn = store.0.lock().unwrap();
                                    out.extend(answer_with(&conn, vec![m]).into_iter().map(Frame::Sink));
                                }
                                Frame::Fleet(m) => {
                                    let mut f = fleet.lock().unwrap();
                                    let reply = f.on(m, now(), &facts());
                                    out.extend(reply.say.into_iter().map(Frame::Fleet));
                                    /* The card opens at once, and the answer
                                       rides back in the same exchange. */
                                    for s in reply.open {
                                        if let Some(a) = f.opened(&s.asked_by.host, &s.request, "card-on-the-desk", now()) {
                                            out.push(Frame::Fleet(a));
                                        }
                                    }
                                }
                                Frame::Cards(_) | Frame::Tail(_) => {}
                            }
                        }
                        out
                    })
                    .await;
                if let Err(e) = out {
                    eprintln!("  the desk could not answer a dial: {e}");
                }
            }
        })
    };

    /* ── one dial, both directions ────────────────────────────────────────── */

    let mut lap_fleet = Fleet::new("laptop", 0);
    lap_fleet.announce(facts(), now());

    println!("laptop dialling the desk …");
    let greeting = {
        let conn = lap_store.0.lock().unwrap();
        let mut g = vec![Frame::Sink(Msg::Hello {
            host: "laptop".into(),
            watermark: skein_lib::sinksync::watermark(&conn).unwrap(),
        })];
        g.extend(lap_fleet.open(now()).into_iter().map(Frame::Fleet));
        g
    };
    let back = laptop.exchange(guess, greeting, true).await.unwrap_or_else(|e| fail("the dial failed", e));

    let mut pulled = 0;
    let mut theirs = None;
    {
        let conn = lap_store.0.lock().unwrap();
        for f in back {
            match f {
                Frame::Sink(Msg::Hello { watermark, .. }) => theirs = Some(watermark),
                Frame::Sink(Msg::Events { events }) => {
                    for e in &events {
                        if skein_lib::sinksync::receive(&conn, e).unwrap_or(false) {
                            pulled += 1;
                        }
                    }
                }
                Frame::Fleet(m) => {
                    lap_fleet.on(m, now(), &facts());
                }
                Frame::Cards(_) | Frame::Tail(_) => {}
            }
        }
    }
    println!("  pulled {pulled} event(s) the laptop was missing");

    /* The push the answer showed was owed — `Link::dial`'s second exchange. */
    let lacking = {
        let conn = lap_store.0.lock().unwrap();
        skein_lib::sinksync::events_after(&conn, &theirs.expect("the desk answered with its watermark")).unwrap()
    };
    println!("  the desk's watermark shows it lacks {} event(s); pushing them", lacking.len());
    laptop
        .exchange(guess, vec![Frame::Sink(Msg::Events { events: lacking })], true)
        .await
        .unwrap_or_else(|e| fail("the push failed", e));

    let lap_has = titles(&lap_store);
    let desk_has = titles(&desk_store);
    println!("\n  the laptop holds: {lap_has:?}");
    println!("  the desk holds:   {desk_has:?}");

    /* ── an ask, over the wire ────────────────────────────────────────────── */

    println!("\nthe laptop asks the desk to open a card …");
    assert!(lap_fleet.entry("desk").is_some(), "the desk's announcement should have crossed in the greeting's answer");
    let ask = lap_fleet
        .ask(
            Request {
                id: "r-1".into(),
                card: Some("asking-card".into()),
                to: "desk".into(),
                territory: skein(),
                brief: "build the thing".into(),
                title: None,
                model: Some("sonnet".into()),
                effort: None,
                needs: Vec::new(),
            },
            now(),
        )
        .unwrap_or_else(|e| fail("the ask would not leave", e.reason()));
    let back = laptop.exchange(guess, vec![Frame::Fleet(ask)], true).await.unwrap_or_else(|e| fail("the ask failed", e));
    let mut answered = Vec::new();
    for f in back {
        if let Frame::Fleet(m @ FleetMsg::Answer { .. }) = f {
            answered.extend(lap_fleet.on(m, now(), &facts()).answered);
        }
    }

    let _ = serving.await;

    println!("\n=== what this run established ===");
    let both = lap_has.len() == 2 && desk_has.len() == 2;
    let opened = matches!(answered.first().map(|a| &a.outcome), Some(Outcome::Opened { card }) if card == "card-on-the-desk");
    if both {
        println!("The sink crossed in BOTH directions from one dial: the laptop pulled the");
        println!("desk's finding, then pushed its own to the desk off the desk's watermark.");
    } else {
        println!("The piles did not converge — laptop {lap_has:?}, desk {desk_has:?}.");
    }
    if opened {
        println!("An ask crossed, the desk's fleet agreed and opened a card, and the answer");
        println!("came back to the laptop's fleet as answered — `fleet.rs` over a real wire.");
    } else {
        println!("The ask did not come back answered as opened: {answered:?}");
    }
    println!("\nWhat it does NOT establish, and only two machines can: NAT traversal");
    println!("between separate networks, and whether an intercepting gateway lets the");
    println!("relay through. See docs/FLYWAY-PROBE.md.");
    let _ = std::fs::remove_dir_all(&root);
    if !(both && opened) {
        std::process::exit(1);
    }
}
