//! The thing that actually runs: a wall that answers dials and makes them.
//!
//! Everything under `flyway/` was built so this file could be short. `seal.rs`
//! makes a frame unreadable, `sync.rs` says how two piles converge, `session.rs`
//! says what two walls say, `wire.rs` carries bytes, and `sinksync.rs` keeps the
//! outbox and applies what arrives. None of them does anything on its own. This
//! starts them.
//!
//! ### Both walls pull; nobody pushes
//!
//! A wall dials each peer it knows and asks for what it is missing. It never
//! sends what the other is missing — the other wall's own dial does that.
//!
//! That is a smaller protocol than it sounds, and it is chosen rather than
//! fallen into. A push needs the sender to know the receiver's watermark, which
//! it only learns by asking, which is a second round trip on a connection that
//! then has to stay open while both ends interleave — and `wire.rs` deliberately
//! finishes its send before reading, because a stream where both ends wait for
//! each other hangs until the idle timeout and reads as a sleeping machine.
//! Symmetric pulling needs none of that: one round trip, one direction, and the
//! other direction is somebody else's turn.
//!
//! The cost is latency, not correctness: a finding dropped here reaches the
//! other wall when *it* next dials, so the pile is eventually right rather than
//! immediately right. For a sink that is the correct trade; for a live
//! transcript it would not be, and that is the point at which this becomes a
//! held-open connection instead.
//!
//! ### A wall never dials itself
//!
//! It would deadlock against its own accept loop, and the case is reachable
//! rather than theoretical: the wall that *started* a flyway has its own name
//! in its stored invite. `key::joined_peer` filters it there, where the fact
//! lives, rather than here where it would be a condition somebody could forget.
//!
//! ### Why this polls, when almost nothing else here does
//!
//! CLAUDE.md's rule is that the wall folds events rather than asking, and names
//! the three places that go and look and why each had no event to fold. This is
//! a fourth and it owes the same argument: **the thing being watched is another
//! machine, which emits nothing we can hear until we open a connection to it.**
//! There is no local event that means "the laptop has had a thought". The
//! residue is bounded the way the others are — one timer however many peers,
//! started when a key exists and stopped when it goes.

use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

use super::key;
use super::session::Msg;
use super::wire::Wire;
use crate::store::Store;

/// How often a wall asks the others what it has missed.
///
/// A sink is not urgent — a finding that arrives a minute late is a finding —
/// and every tick is a connection attempt per peer, which on a relay is a round
/// trip somebody else pays for. Slow enough to be polite, fast enough that
/// "drop it on the laptop, see it on the desk" happens while you are still
/// thinking about it.
const EVERY: Duration = Duration::from_secs(45);

/// The running link, if this wall has a key.
#[derive(Default)]
pub struct Flyway(pub Mutex<Option<Arc<Wire>>>);

/// Bring the link up, if there is a key to bring it up with.
///
/// Idempotent: called at launch and again whenever a key is entered, because
/// those are the two moments a wall can become a member and neither should have
/// to know about the other.
pub async fn arrive(app: AppHandle) -> Result<bool, String> {
    let Some(k) = key::wall_key() else {
        return Ok(false);
    };
    let here = key::host_name();

    let state = app.state::<Flyway>();
    {
        let held = state.0.lock().await;
        if held.is_some() {
            return Ok(true);
        }
    }

    let wire = Arc::new(Wire::start(k, &here).await?);
    *state.0.lock().await = Some(wire.clone());

    /* Answer anybody who dials. Spawned rather than awaited for the obvious
       reason, and detached rather than held because the endpoint closing is
       what ends it — a handle to abort would be a second way to stop one thing. */
    let serving = app.clone();
    let answers = wire.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let out = answers
                .serve_one(|heard| answer(&serving, heard))
                .await;
            if let Err(e) = out {
                /* A failed dial is somebody else's network, not a reason to stop
                   listening. Logged rather than surfaced: the wall has nothing
                   useful to say about one stranger's half-open connection. */
                log::debug!("flyway: a dial came to nothing: {e}");
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    });

    /* And ask the others what we have missed — **now, then for ever.**
    
       The sleep is after the ask rather than before it, which is the whole of
       the difference between joining a flyway and watching nothing happen for
       the better part of a minute. `arrive` is called when a key is entered as
       well as at launch, so the ask-first order is also what makes pasting an
       invite produce an answer on the spot: the panel says the link is up, and
       by the time you have read that, the pile has arrived.
    
       That window is exactly when somebody is watching to see whether it
       worked, and a feature that is indistinguishable from a broken one for
       forty-five seconds is one people give up on at second thirty. */
    let asking = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            if let Err(e) = pull(asking.clone()).await {
                /* A peer that is asleep is the ordinary case, not a fault —
                   the other machine is a laptop in a bag most of the day. */
                log::debug!("flyway: nothing came back this time: {e}");
            }
            tokio::time::sleep(EVERY).await;
        }
    });

    Ok(true)
}

/// What to say to a wall that dialled us: our own hello, and everything it is
/// missing.
///
/// Reads the store rather than holding a `Session`, because the outbox *is* the
/// session's log and keeping a second copy in memory is a second thing to get
/// out of step. `sinksync` owns both ends of that.
fn answer(app: &AppHandle, heard: Vec<Msg>) -> Vec<Msg> {
    let Some(store) = app.try_state::<Store>() else {
        return Vec::new();
    };
    let Ok(conn) = store.0.lock() else {
        return Vec::new();
    };
    answer_with(&conn, heard)
}

/// The same, against a connection rather than an app.
///
/// Split out so the integrated path — a real outbox, a real fold, a real
/// connection — can be exercised by `examples/flyway-link.rs` without a Tauri
/// app around it. The pieces below this all had tests; what had none was the
/// sequence, and a sequence nobody has run is a sequence nobody has checked.
pub fn answer_with(conn: &rusqlite::Connection, heard: Vec<Msg>) -> Vec<Msg> {
    let mut out = Vec::new();
    for m in heard {
        match m {
            Msg::Hello { watermark, .. } => {
                let mine = crate::sinksync::watermark(conn).unwrap_or_default();
                out.push(Msg::Hello { host: key::host_name(), watermark: mine });
                if let Ok(events) = crate::sinksync::events_after(conn, &watermark) {
                    if !events.is_empty() {
                        out.push(Msg::Events { events });
                    }
                }
            }
            /* A wall that pushes anyway is not refused — the fold is idempotent
               and a frame we did not ask for is still news. */
            Msg::Events { events } => {
                for e in &events {
                    let _ = crate::sinksync::receive(conn, e);
                }
            }
        }
    }
    out
}

/// Ask every peer for what we are missing, and fold it in.
pub async fn pull(app: AppHandle) -> Result<usize, String> {
    let wire = {
        let state = app.state::<Flyway>();
        let held = state.0.lock().await;
        held.clone()
    };
    let Some(wire) = wire else {
        return Err("this wall is not on a flyway".to_string());
    };

    let Some(peer_host) = key::joined_peer() else {
        /* A wall that started the flyway and has never been joined *to* has
           nobody to ask. It is not an error: it answers dials and waits. */
        return Ok(0);
    };

    let hello = {
        let store = app.state::<Store>();
        let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
        Msg::Hello {
            host: key::host_name(),
            watermark: crate::sinksync::watermark(&conn)?,
        }
    };

    let peer = wire.peer(&peer_host)?;
    let back = wire.exchange(peer, vec![hello]).await?;

    let store = app.state::<Store>();
    let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
    let mut news = 0;
    for m in back {
        if let Msg::Events { events } = m {
            for e in &events {
                if crate::sinksync::receive(&conn, e).unwrap_or(false) {
                    news += 1;
                }
            }
        }
    }
    Ok(news)
}

/* ── the commands ─────────────────────────────────────────────────────────── */

/// Bring the link up now — called after a key is entered, so joining a flyway
/// does not need a restart to take effect.
#[tauri::command]
pub async fn flyway_arrive(app: AppHandle) -> Result<bool, String> {
    arrive(app).await
}

/// Ask the others now rather than at the next tick, and say how much was news.
#[tauri::command]
pub async fn flyway_pull(app: AppHandle) -> Result<usize, String> {
    pull(app).await
}

/// Whether the link is up, which is a different question from whether a key is
/// held: a wall with a key whose endpoint could not bind is a wall that will
/// sync nothing, and the two must not look alike.
#[tauri::command]
pub async fn flyway_linked(app: AppHandle) -> bool {
    let state = app.state::<Flyway>();
    let held = state.0.lock().await;
    held.is_some()
}
