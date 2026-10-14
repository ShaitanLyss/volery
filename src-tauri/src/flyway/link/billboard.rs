//! The billboard's half of the link: saying this wall's board, holding the
//! others', and the one exchange that takes a notice down from another wall.
//!
//! `boards.rs` is the vocabulary and its reasoning, `board.rs` decides what a
//! notice means; this is only the wiring between them, a child of `link.rs`
//! for `moves.rs`'s reason — it uses the wire and the fleet without either
//! growing a public face for one subsystem.

use std::sync::atomic::Ordering;
use std::sync::{mpsc, Arc};
use std::time::Duration;

use super::{here, Frame, Link, CARDS_EVERY};
use crate::flyway::boards::{self, BoardMsg, Reply, Seen, Taker};

/// How long a card's `unpost` of another wall's notice waits for the answer.
/// The exchange itself is bounded at twenty seconds (`wire.rs`), dial
/// included; this is that and a little, so the answer that does come is read.
const UNPOST_WITHIN: Duration = Duration::from_secs(25);

impl Link {
    /// This wall's board as it stands, said now — or nothing while the store
    /// is not there to read it from.
    pub(super) fn board_say(&self) -> Option<BoardMsg> {
        let notices = crate::board::published(&self.app)?;
        let (m, moved) = self.boards.lock().ok()?.say(notices, self.now());
        if moved {
            /* Kept when it moves, for `Fleet::announce`'s reason: a crash is
               the restart this exists for. */
            let version = self.boards.lock().map(|b| b.version()).unwrap_or(0);
            if let Some(store) = self.store() {
                if let Ok(conn) = store.0.lock() {
                    let _ = here::set_setting(&conn, here::BOARD_VERSION, &version.to_string());
                }
            }
        }
        Some(m)
    }

    /// Another wall's board. Redrawn here only when it says something new; a
    /// repeat refreshes its ages and nothing else.
    pub(super) fn on_board(&self, m: BoardMsg) {
        let news = self.boards.lock().map(|mut b| b.on(m, self.now())).unwrap_or(false);
        if news {
            crate::board::heard_from_afar(&self.app);
        }
    }

    /// A wall asking this one to take one of its notices down — decided by
    /// `board.rs` against this wall's own ladder, read fresh. `None` for an id
    /// that is not one this app minted: there is no question to answer.
    pub(super) fn unpost_here(&self, m: BoardMsg, from: Option<&str>) -> Option<BoardMsg> {
        let BoardMsg::Unpost { id, notice, by, confirm } = m else {
            return None;
        };
        if !super::act::is_id(&id) {
            return None;
        }
        let Some(host) = from else {
            return Some(boards::unposted(
                &id,
                Err(format!(
                    "{} could not tell which wall asked — it may not have heard from yours yet; try again in a minute",
                    self.me
                )),
            ));
        };
        let r = crate::board::unpost_for_afar(&self.app, notice.trim(), by.as_ref(), confirm, host);
        Some(boards::unposted(&id, r))
    }

    /// This wall's board changed: say it to every wall that can hear it within
    /// `CARDS_EVERY`, coalesced as a cards snapshot is, so a burst of posts is
    /// one push carrying the last of them. The tick says it again regardless,
    /// so a push that fails costs half a minute and never the notice — and an
    /// orchestrator's `unpost` reaches its workers on the other machine in about
    /// a second rather than at the next exchange.
    pub(crate) fn board_changed(self: &Arc<Self>) {
        if self.board_due.swap(true, Ordering::AcqRel) {
            return;
        }
        let l = self.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(CARDS_EVERY).await;
            l.board_due.store(false, Ordering::Release);
            let Some(m) = l.board_say() else { return };
            for host in l.known_current() {
                l.push(host, vec![Frame::Board(m.clone())]);
            }
        });
    }

    /// Every notice another wall holds up, ages advanced to now, each with how
    /// long its wall has gone unheard — the roster's word where it has one,
    /// which is the same reading the shadows and the `walls` tool are given.
    pub fn boards_seen(&self) -> Vec<(Seen, u64)> {
        let now = self.now();
        let seen = self.boards.lock().map(|b| b.seen(now)).unwrap_or_default();
        let Ok(f) = self.fleet.lock() else { return Vec::new() };
        seen.into_iter()
            .map(|s| {
                let wall = f.entry(&s.host).map(|e| e.quiet_for(now)).unwrap_or(s.heard_ms);
                (s, wall)
            })
            .collect()
    }

    /// How many of each wall's notices did not fit its picture.
    pub fn boards_withheld(&self) -> Vec<(String, u32)> {
        self.boards.lock().map(|b| b.withheld()).unwrap_or_default()
    }

    /// The walls a notice posted here reaches now — the ones a push goes to.
    pub fn flying_with(&self) -> Vec<String> {
        self.known_current()
    }

    /// Ask `host` to take one of its notices down, and wait for the answer.
    ///
    /// **Blocking, on purpose, and only ever called off the main thread** —
    /// from a parked MCP call's own thread, or `off_main`. `board::unpost` has
    /// to decide before the transport commits to answering, and the decision
    /// is the far wall's. Refused at once for a wall that is unknown, quiet or
    /// too old (`reachable`), never queued: a takedown landing when a lid lifts
    /// hours later would be a decision about a board nobody has looked at since.
    pub fn unpost_there(self: &Arc<Self>, host: &str, notice: &str, by: Option<Taker>, confirm: bool) -> Result<Reply, String> {
        self.reachable(
            host,
            boards::WORD,
            "cannot take its notices down for another wall — update it, or take this one down there",
        )?;
        let peer = self.wire.peer(host)?;
        let id = crate::store::uuid_v4();
        let ask = Frame::Board(BoardMsg::Unpost { id: id.clone(), notice: notice.to_string(), by, confirm });
        let (tx, rx) = mpsc::channel();
        let l = self.clone();
        let there = host.to_string();
        tauri::async_runtime::spawn(async move {
            /* Never touches `failing`, for `read_tail`'s reason. And a fault is
               not "nothing happened": the far wall may have taken it down and
               lost the answer on the way back. */
            let r = match l.wire.exchange(peer, vec![ask], true).await {
                Err(e) => Err(format!(
                    "did not hear back from {there} ({e}) — the notice may or may not have come down; read the \
                     board again before asking"
                )),
                Ok(back) => {
                    let mut said = Vec::new();
                    let mut rest = Vec::new();
                    for f in back {
                        match f {
                            Frame::Board(m @ BoardMsg::Unposted { .. }) => said.push(m),
                            other => rest.push(other),
                        }
                    }
                    /* The rest carries the far wall's board as it stands after
                       answering, so a notice taken down leaves this wall's copy
                       in the same exchange. */
                    l.take(rest, Some(&there));
                    boards::answer_in(&said, &id, &there)
                }
            };
            let _ = tx.send(r);
        });
        rx.recv_timeout(UNPOST_WITHIN).unwrap_or_else(|_| {
            Err(format!(
                "{host} did not answer in time — the notice may or may not have come down; read the board again \
                 before asking"
            ))
        })
    }
}
