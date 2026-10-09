//! A move between walls, wired. `flyway/moving.rs` is the design and holds
//! every decision that can be made without a socket, a store or a process;
//! this file is the doing, on both walls, and it is a child of `link.rs` so it
//! can use the link's own wire and fleet without either of them growing a
//! public face for one subsystem.
//!
//! **The leaving wall (A)**: `move_out` checks everything it can see — the
//! other wall, the card, its tree, its transcript — writes the move down,
//! stops the card's process and freezes it (`blocks`), then `ship` offers the
//! card and sends the transcript in parts, each an exchange of its own
//! answered on the same stream. Then it waits to be told how it ended
//! (`settled`), and gives up after `moving::SETTLE_WITHIN_MS`, keeping its card.
//!
//! **The arriving wall (B)**: `offered` decides whether it will take the card,
//! `part` gathers the transcript, and `arrive` plants it where this machine's
//! CLI will look, writes the row and the lineage, and hands the card to the
//! front end to be born through `#openIn` with its first prompt the check
//! (`moving::confirm_prompt`). When that turn ends, `check` reads the answer
//! off the transcript the CLI wrote and says how it went to A until A answers
//! (`tell_move`). If A kept its own copy, B takes its copy away — unless somebody
//! has spoken to it since, in which case both stay and both walls say so.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::Link;
use crate::flyway::fleet::{self, Origin};
use crate::flyway::frame::Frame;
use crate::flyway::here::{self, MoveRow};
use crate::flyway::moving::{self, Afar, Arrival, Arriving, Challenge, Code, MoveMsg, Moving, Out};
use crate::store::Store;

/// How long a wall goes on telling the sending wall how a move ended before it
/// stops: a day, which is longer than any lid stays shut on purpose and short
/// of a dial every half minute for the rest of the machine's life.
const TELL_FOR_MS: i64 = 24 * 60 * 60_000;

/// Transcripts arriving in parts, by the sending wall and the move.
fn arriving() -> &'static Mutex<HashMap<(String, String), Arriving>> {
    static A: OnceLock<Mutex<HashMap<(String, String), Arriving>>> = OnceLock::new();
    A.get_or_init(Default::default)
}

/// Cards born here by a move and still proving they have their history: the
/// card and the move. **In memory on purpose** — after a restart a card on this
/// list is one whose check this process never sent, so it is not let spawn
/// (`blocks`) and the sweep takes it away; resuming it would put a rouse
/// prompt where the check should have been.
fn confirming() -> &'static Mutex<HashMap<String, String>> {
    static C: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    C.get_or_init(Default::default)
}

fn scrub(s: &str) -> String {
    crate::clean::scrub(s).into_owned()
}

/// An id that is going to be a file name or a database key on this machine:
/// letters, digits and dashes, and short. A session id becomes
/// `<session>.jsonl` under the CLI's projects directory, so anything else is
/// a path somebody else wrote.
fn plain_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// A branch name that is going to be an argument to git: no leading dash (an
/// option), no whitespace, no control character, nothing git itself refuses in
/// a ref at the obvious places.
fn plain_branch(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 200
        && !s.starts_with('-')
        && !s.contains("..")
        && !s.chars().any(|c| c.is_whitespace() || c.is_control() || "~^:?*[\\".contains(c))
}

/* ── what crosses to the front end ────────────────────────────────────────── */

/// How a move out is going, on the wall it is leaving. `stage` is `shipping`,
/// `confirming`, `moved` or `kept`.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MoveStage {
    id: String,
    request: String,
    to: String,
    stage: &'static str,
    why: Option<String>,
}

/// A card arriving: everything `Skein.openMoved` needs to birth it through
/// `#openIn`, and the prompt that is its check.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MoveIn {
    id: String,
    request: String,
    cwd: String,
    worktree: Option<String>,
    session: String,
    title: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    prompt: String,
    from_host: String,
}

/// A card this wall is taking off again — its check failed, or the wall it
/// came from kept its own copy.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Withdrawn {
    id: String,
    why: String,
}

/* ── the guard every spawn asks ───────────────────────────────────────────── */

/// Whether this card may be given a process now, or why not. Asked by
/// `supervisor::spawn_now`, which every wake reaches.
pub fn blocks(app: &AppHandle, card: &str) -> Option<String> {
    let store = app.try_state::<Store>()?;
    let row = {
        let conn = store.0.lock().ok()?;
        here::moving_now(&conn, card)?
    };
    if row.direction == "out" {
        return Some(format!(
            "this card is moving to {} and is not woken here while the move is under way. If {} does \
             not confirm it within {} minutes it stays here, as it was",
            row.host,
            row.host,
            moving::SETTLE_WITHIN_MS / 60_000
        ));
    }
    let ours = confirming().lock().ok().is_some_and(|c| c.get(card) == Some(&row.request));
    (!ours).then(|| {
        format!(
            "this card arrived from {} and has not shown it has its history here, so it is not woken — \
             it is still on {}",
            row.host, row.host
        )
    })
}

/// A turn has ended on some card. If it is one proving it has its history,
/// read the answer once the CLI has had a moment to write it down.
pub fn turn_closed(app: &AppHandle, card: &str) {
    let Some(request) = confirming().lock().ok().and_then(|c| c.get(card).cloned()) else {
        return;
    };
    let app = app.clone();
    let card = card.to_string();
    std::thread::spawn(move || {
        /* `result` is on the wire before the assistant record is guaranteed to
           be on disk; a second and a half is generous for a local append. */
        std::thread::sleep(Duration::from_millis(1500));
        if let Some(link) = super::link(&app) {
            link.check(&card, &request);
        }
    });
}

impl Link {
    /* ── leaving ──────────────────────────────────────────────────────────── */

    /// Move a card on this wall to `to`. Everything that can be refused here is
    /// refused here, at once and in words — a move is never queued for a wall
    /// that cannot take it, for a2a4468e's reason. Returns the move's id; how
    /// it ends arrives as `flyway:move` events.
    pub fn move_out(self: &Arc<Self>, card: &str, to: &str) -> Result<String, String> {
        let to = to.trim().to_string();
        let now = self.now();
        if to.eq_ignore_ascii_case(&self.me) {
            return Err("that is this wall — the card is already here".into());
        }
        let (territories, accepting) = {
            let f = self.fleet.lock().map_err(|_| "the fleet is wedged".to_string())?;
            let Some(e) = f.entry(&to) else {
                let known: Vec<String> = f.roster().filter(|e| e.host != self.me).map(|e| e.host.clone()).collect();
                return Err(fleet::Unsendable::UnknownHost { host: to, known }.reason());
            };
            let quiet = e.quiet_for(now);
            if quiet > fleet::QUIET_AFTER_MS as u64 {
                return Err(fleet::Unsendable::Quiet { host: to, for_ms: quiet }.reason());
            }
            if !e.facts.can.iter().any(|c| c == moving::WORD) {
                return Err(format!(
                    "{to} runs a Volery from before cards could move between walls — update it there \
                     first; nothing was moved"
                ));
            }
            (e.facts.territories.clone(), e.facts.accepting)
        };
        if self.speaks_older(&to) {
            return Err(format!("{to} answers only in the older language — update it there first; nothing was moved"));
        }
        /* A move is work arriving on that wall, so its switch holds it like a
           spawn. */
        if !accepting {
            return Err(fleet::Refusal::NotAccepting.reason(&to));
        }

        let store = self.store().ok_or("the store is unavailable")?;
        let (row, origin, children, afar, waiting) = {
            let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
            let Some(row) = here::card_row(&conn, card) else {
                return Err("there is no card by that id on this wall".into());
            };
            let origin = here::birth_of(&conn, card)
                .map(|b| Origin { host: b.host, card: b.asker_card })
                .or_else(|| crate::store::spawner_of(&conn, card).map(|p| Origin { host: self.me.clone(), card: Some(p) }));
            let children = here::children_here(&conn, card);
            let afar: Vec<Afar> =
                here::children_of(&conn, card).into_iter().map(|c| Afar { host: c.host, card: c.card }).collect();
            (row, origin, children, afar, in_flight_here(&conn, card))
        };
        if !row.open {
            return Err("that card is closed — there is nothing running to move".into());
        }
        if row.kind == "chat" {
            return Err("a chat card stands outside the wall's projects and has no repository to move with".into());
        }
        if !territories.iter().any(|t| t.identity == row.project) {
            let has: Vec<String> = territories.iter().map(|t| t.name.clone()).collect();
            return Err(format!(
                "{to} has no territory called {} — it has {}. Open the repository there first; the card \
                 moves into a checkout the other machine already has",
                row.project,
                if has.is_empty() { "none at all".to_string() } else { has.join(", ") }
            ));
        }
        if let Some(why) = waiting {
            return Err(why);
        }
        {
            let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
            if let Some(m) = here::moving_now(&conn, card) {
                return Err(format!("it is already moving to {}", m.host));
            }
        }
        let sup = self.app.state::<crate::supervisor::Supervisor>();
        if sup.liveness(card).1 {
            return Err("it is mid-turn — let it finish, then move it".into());
        }

        /* The conversation, read whole. It is the one thing that moves over the
           flyway rather than by git, and the check needs a line of it. */
        let dir = crate::worktree::run_dir(&row.cwd, row.worktree.as_deref());
        let path = crate::supervisor::transcript_path(&self.app, &dir, &row.session)?;
        let text = std::fs::read_to_string(&path).map_err(|_| {
            "it has no conversation on disk yet — a card that has never spoken has nothing to move; open a \
             fresh one there instead"
                .to_string()
        })?;
        if text.len() as u64 > moving::MOST_BYTES {
            return Err(format!(
                "its conversation is {} MB, more than a move carries ({} MB) — hand it off instead",
                text.len() / (1024 * 1024),
                moving::MOST_BYTES / (1024 * 1024)
            ));
        }
        if moving::challenge_of(&text).is_none() {
            return Err(
                "nothing it has said is long enough to check it remembers it on the other side — ask it \
                 something first, then move it"
                    .into(),
            );
        }

        /* The code moves by git: clean, and on a remote. */
        let (ok, status, err) = crate::worktree::run(&dir, &["status", "--porcelain", "-unormal"]);
        if !ok {
            return Err(format!("could not read the state of its tree: {err}"));
        }
        let (_, sha, _) = crate::worktree::run(&dir, &["rev-parse", "HEAD"]);
        let (_, branch, _) = crate::worktree::run(&dir, &["rev-parse", "--abbrev-ref", "HEAD"]);
        let (_, on_remote, _) = crate::worktree::run(&dir, &["branch", "-r", "--contains", "HEAD"]);
        if let Some(why) = moving::tree_refusal(&status, &on_remote, &sha) {
            return Err(why);
        }
        let branch = (!branch.is_empty() && branch != "HEAD").then_some(branch);

        let parts = moving::split(&text);
        let manifest = Moving {
            card: row.id.clone(),
            session: row.session.clone(),
            title: row.title.clone(),
            named: row.named,
            model: row.model.clone(),
            effort: row.effort.clone(),
            gear: row.gear.clone(),
            worktree: row.worktree.clone(),
            territory: row.project.clone(),
            code: Code { sha, branch },
            origin,
            children,
            afar,
            parts: parts.len() as u32,
            bytes: text.len() as u64,
        };

        /* Written down before the card is stopped: from this line the card is
           frozen (`blocks`) and the row is what says why, crash or no crash. */
        let request = crate::store::uuid_v4();
        {
            let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
            here::record_move(&conn, &request, card, "out", &to, now, None, None)?;
        }
        if crate::supervisor::stop_unless_turning(&self.app, card).is_err() {
            self.keep(&request, card, &to, "it started a turn as the move began — let it finish, then move it");
            return Err("it started a turn as the move began — let it finish, then move it".into());
        }
        self.stage(card, &request, &to, "shipping", None);
        let l = self.clone();
        let (r, c) = (request.clone(), card.to_string());
        tauri::async_runtime::spawn(async move { l.ship(r, c, to, manifest, parts).await });
        Ok(request)
    }

    /// Offer the card, then send the parts. Every failure here keeps the card
    /// on this wall — nothing has been released, so nothing is lost.
    async fn ship(self: Arc<Self>, request: String, card: String, to: String, manifest: Moving, parts: Vec<String>) {
        let peer = match self.wire.peer(&to) {
            Ok(p) => p,
            Err(e) => return self.keep(&request, &card, &to, &format!("could not find {to}: {e}")),
        };
        match self.move_exchange(peer, &to, &request, MoveMsg::MoveOffer { id: request.clone(), card: manifest }).await {
            Ok((true, _, _)) => {}
            Ok((false, _, why)) => {
                let why = why.unwrap_or_else(|| format!("{to} would not take it"));
                return self.keep(&request, &card, &to, &why);
            }
            Err(e) => return self.keep(&request, &card, &to, &e),
        }
        for (index, text) in parts.into_iter().enumerate() {
            let mut tries = 0;
            loop {
                let m = MoveMsg::MovePart { id: request.clone(), index: index as u32, text: text.clone() };
                match self.move_exchange(peer, &to, &request, m).await {
                    Ok((true, _, _)) => break,
                    Ok((false, _, why)) => {
                        let why = why.unwrap_or_else(|| format!("{to} stopped taking it"));
                        return self.keep(&request, &card, &to, &why);
                    }
                    Err(_) if tries < 2 => {
                        tries += 1;
                        tokio::time::sleep(Duration::from_secs(2)).await;
                    }
                    Err(e) => return self.keep(&request, &card, &to, &e),
                }
            }
        }
        self.stage(&card, &request, &to, "confirming", None);
    }

    /// One move frame to `host`, and its answer off the same stream. Anything
    /// else the far wall says back — its cards, most often — is folded in as
    /// any answer is.
    async fn move_exchange(
        self: &Arc<Self>,
        peer: iroh::EndpointId,
        host: &str,
        request: &str,
        m: MoveMsg,
    ) -> Result<(bool, u32, Option<String>), String> {
        let back = self.wire.exchange(peer, vec![Frame::Move(m)], true).await.map_err(|e| format!("could not reach {host}: {e}"))?;
        let mut answer = None;
        let mut rest = Vec::new();
        for f in back {
            match f {
                Frame::Move(MoveMsg::MoveAnswer { id, ok, have, why }) if id == request => {
                    answer = Some((ok, have, why.map(|w| scrub(&w))))
                }
                other => rest.push(other),
            }
        }
        let _ = self.take(rest, Some(host));
        answer.ok_or_else(|| format!("{host} did not answer the move — it may be a build that cannot take one"))
    }

    /// This wall keeps its card: the move failed, or nobody said in time.
    fn keep(&self, request: &str, card: &str, to: &str, why: &str) {
        if let Some(store) = self.store() {
            if let Ok(conn) = store.0.lock() {
                here::settle_move(&conn, request, "kept", Some(why), self.now());
            }
        }
        self.stage(card, request, to, "kept", Some(scrub(why)));
    }

    fn stage(&self, card: &str, request: &str, to: &str, stage: &'static str, why: Option<String>) {
        let _ = self.app.emit(
            "flyway:move",
            MoveStage { id: card.to_string(), request: request.to_string(), to: to.to_string(), stage, why },
        );
    }

    /// The arriving wall says how it went. Decided once (`moving::settle_out`)
    /// and answered from that decision every time after.
    fn settled(self: &Arc<Self>, from: &str, request: &str, card: &str, ok: bool, why: Option<String>) -> MoveMsg {
        let now = self.now();
        let Some(store) = self.store() else {
            return MoveMsg::MoveReleased { id: request.into(), released: false, why: Some("the store is unavailable".into()) };
        };
        let row = store.0.lock().ok().and_then(|c| here::move_of(&c, request));
        /* Only the move this wall sent, to that wall, of that card. A row that
           says otherwise is not this move, and the answer is "kept" — which
           takes nothing away anywhere but the other wall's own copy. */
        let row = row.filter(|r| r.direction == "out" && r.host == from && r.card == card);
        let state = row.as_ref().map(|r| Out::from_word(r.outcome.as_deref()));
        let (next, released) = moving::settle_out(state, ok);
        if state == Some(Out::InFlight) {
            let written = store
                .0
                .lock()
                .map(|c| here::settle_move(&c, request, next.word().unwrap_or("kept"), why.as_deref(), now))
                .unwrap_or(false);
            if written {
                if released {
                    self.release(card, from, request);
                } else {
                    let why = why.clone().unwrap_or_else(|| format!("{from} could not confirm it"));
                    self.stage(card, request, from, "kept", Some(scrub(&why)));
                }
            }
        }
        let why = (!released).then(|| match next {
            Out::Kept => format!("{} kept the card — {}", self.me, row.and_then(|r| r.why).unwrap_or_else(|| "the move had already ended here".into())),
            _ => format!("{} has no record of moving that card", self.me),
        });
        MoveMsg::MoveReleased { id: request.into(), released, why: why.map(|w| scrub(&w)) }
    }

    /// The card answered with its history over there: this copy is closed and
    /// marked moved, never deleted, and the lineage on this wall is re-pointed
    /// so a parent here and children here can still reach it.
    fn release(&self, card: &str, to: &str, request: &str) {
        let now = self.now();
        let mut title = None;
        if let Some(store) = self.store() {
            if let Ok(conn) = store.0.lock() {
                title = here::card_row(&conn, card).and_then(|r| r.title);
                let _ = conn.execute(
                    "UPDATE conversation SET closed_at = ?2 WHERE id = ?1 AND closed_at IS NULL",
                    rusqlite::params![card, now],
                );
                /* Its parent here reaches it there as a child elsewhere, and its
                   children here answer to it there as cards another wall asked
                   for — the two tables the switch reads (`fleet::may_reach`). */
                if let Some(parent) = crate::store::spawner_of(&conn, card) {
                    let _ = here::record_child(&conn, to, card, &parent, request, now);
                }
                for child in here::children_here(&conn, card) {
                    let _ = here::record_birth(&conn, &child, request, to, Some(card), now);
                }
            }
        }
        crate::chronicle::note(
            &self.app,
            None,
            "volery",
            "good",
            &format!("moved a card to {to}"),
            &match title {
                Some(t) => format!("{t} — it answered with its history there, and runs on {to} now"),
                None => format!("it answered with its history there, and runs on {to} now"),
            },
        );
        self.stage(card, request, to, "moved", None);
    }

    /* ── arriving ─────────────────────────────────────────────────────────── */

    /// A move frame from another wall, on the serving side.
    pub(super) fn on_move(self: &Arc<Self>, m: MoveMsg, from: Option<&str>) -> Option<MoveMsg> {
        let no = |id: &str, why: String| MoveMsg::MoveAnswer { id: id.into(), ok: false, have: 0, why: Some(scrub(&why)) };
        let Some(from) = from else {
            /* A settlement from a wall this one cannot name is not answered at
               all, so it is said again rather than answered wrongly. */
            return match m {
                MoveMsg::MoveOffer { id, .. } | MoveMsg::MovePart { id, .. } => {
                    Some(no(&id, "this wall could not tell which wall you are".into()))
                }
                _ => None,
            };
        };
        match m {
            MoveMsg::MoveOffer { id, card } => Some(self.offered(from, &id, card).unwrap_or_else(|why| no(&id, why))),
            MoveMsg::MovePart { id, index, text } => Some(self.part(from, &id, index, text).unwrap_or_else(|why| no(&id, why))),
            MoveMsg::MoveSettled { id, card, ok, why } => Some(self.settled(from, &id, &card, ok, why.map(|w| scrub(&w)))),
            MoveMsg::MoveAnswer { .. } | MoveMsg::MoveReleased { .. } => None,
        }
    }

    /// Whether this wall takes the card. Everything it can refuse it refuses
    /// before a byte of the conversation arrives.
    fn offered(self: &Arc<Self>, from: &str, id: &str, card: Moving) -> Result<MoveMsg, String> {
        let card = clean(card)?;
        let facts = self.facts();
        let store = self.store().ok_or("the store is unavailable")?;
        let own = self.own_dirs();
        let own: Vec<&std::path::Path> = own.iter().map(|p| p.as_path()).collect();
        {
            let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
            if !here::accepting(&conn) {
                return Err(fleet::Refusal::NotAccepting.reason(&self.me));
            }
            here::root_for(&conn, &card.territory, &own)?;
            if here::card_row(&conn, &card.card).is_some_and(|r| r.open) {
                return Err(format!("{} already has that card open — it may have moved here before", self.me));
            }
            if here::moving_now(&conn, &card.card).is_some() {
                return Err(format!("{} is already in the middle of moving that card", self.me));
            }
        }
        /* The bounds on arriving work are this wall's, and a card moving in is
           arriving work exactly as one opened for another wall is. */
        let gathering = arriving().lock().map(|a| a.len() as u32).unwrap_or(0);
        if let Some(r) = fleet::over_bound(&facts, gathering) {
            return Err(r.reason(&self.me));
        }
        let a = Arriving::new(from, card, self.now())?;
        arriving()
            .lock()
            .map_err(|_| "the flyway is wedged".to_string())?
            .insert((from.to_string(), id.to_string()), a);
        Ok(MoveMsg::MoveAnswer { id: id.into(), ok: true, have: 0, why: None })
    }

    /// One part in. The last one sets the arrival going and is answered at
    /// once — planting runs git, and the sender's exchange is twenty seconds.
    fn part(self: &Arc<Self>, from: &str, id: &str, index: u32, text: String) -> Result<MoveMsg, String> {
        let key = (from.to_string(), id.to_string());
        let mut all = arriving().lock().map_err(|_| "the flyway is wedged".to_string())?;
        let Some(a) = all.get_mut(&key) else {
            return Err(format!(
                "{} has no move under that id — it may have restarted since the offer; move the card again",
                self.me
            ));
        };
        let have = a.add(index, text)?;
        match a.whole() {
            None => Ok(MoveMsg::MoveAnswer { id: id.into(), ok: true, have, why: None }),
            Some(Err(why)) => {
                all.remove(&key);
                Err(why)
            }
            Some(Ok(whole)) => {
                let a = all.remove(&key).expect("just read");
                drop(all);
                let l = self.clone();
                let (from, id) = (from.to_string(), id.to_string());
                tauri::async_runtime::spawn_blocking(move || l.arrive(&from, &id, a.card, whole));
                Ok(MoveMsg::MoveAnswer { id: key.1, ok: true, have, why: None })
            }
        }
    }

    /// Plant the conversation where this machine's CLI will look for it, write
    /// the row and the lineage, and hand the card to the front end with its
    /// check as its first prompt. Any failure is a move that failed here,
    /// written down and told to the wall it came from, which keeps its card.
    fn arrive(self: &Arc<Self>, from: &str, request: &str, card: Moving, text: String) {
        let now = self.now();
        let Some(store) = self.store() else { return };
        let Some(challenge) = moving::challenge_of(&text) else {
            return self.arrival_failed(from, request, &card.card, "nothing it said is long enough to check it remembers");
        };
        let token = moving::token_for(request);
        {
            let Ok(conn) = store.0.lock() else { return };
            let challenge = serde_json::to_string(&challenge).unwrap_or_default();
            /* Before anything else is touched here: from this row on, a crash
               leaves a move the sweep can settle and tell. */
            if here::record_move(&conn, request, &card.card, "in", from, now, Some(&challenge), Some(&token)).is_err() {
                return;
            }
        }
        match self.plant(from, request, &card, &text, &challenge, &token) {
            Ok(()) => {}
            Err(why) => self.arrival_failed(from, request, &card.card, &why),
        }
    }

    fn plant(
        self: &Arc<Self>,
        from: &str,
        request: &str,
        card: &Moving,
        text: &str,
        challenge: &Challenge,
        token: &str,
    ) -> Result<(), String> {
        let store = self.store().ok_or("the store is unavailable")?;
        let own = self.own_dirs();
        let own: Vec<&std::path::Path> = own.iter().map(|p| p.as_path()).collect();
        let root = {
            let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
            here::root_for(&conn, &card.territory, &own)?
        };
        let sha = &card.code.sha;

        /* The tree. A card on a branch of its own gets that branch here: the
           remote's copy if there is one, else the very commit it left at if this
           machine has it — so `worktree::ensure` checks it out rather than
           branching afresh off the base, which is a card on the wrong code. */
        let dir = match card.worktree.as_deref() {
            Some(name) => {
                let _ = crate::worktree::run(&root, &["fetch", "origin", "--quiet"]);
                let local = format!("refs/heads/{name}");
                if !crate::worktree::run(&root, &["rev-parse", "--verify", "--quiet", &local]).0 {
                    let remote = format!("refs/remotes/origin/{name}");
                    if crate::worktree::run(&root, &["rev-parse", "--verify", "--quiet", &remote]).0 {
                        let _ = crate::worktree::run(&root, &["branch", "--no-track", name, &format!("origin/{name}")]);
                    } else if crate::worktree::run(&root, &["cat-file", "-e", &format!("{sha}^{{commit}}")]).0 {
                        let _ = crate::worktree::run(&root, &["branch", name, sha]);
                    }
                }
                crate::worktree::ensure(&root, name)?
            }
            None => root.clone(),
        };
        let ancestor = |d: &str| crate::worktree::run(d, &["merge-base", "--is-ancestor", sha, "HEAD"]).0;
        let has_code = if ancestor(&dir) {
            Some(true)
        } else {
            let _ = crate::worktree::run(&dir, &["fetch", "origin", "--quiet"]);
            Some(ancestor(&dir))
        };

        /* The conversation, where the CLI looks: this machine's home, the slug
           of the directory the child will run in, the session id as the name.
           Never over a different file — a copy already here that is not this
           one is somebody's conversation. */
        let path = crate::supervisor::transcript_path(&self.app, &dir, &card.session)?;
        let there = if path.exists() {
            Some(std::fs::read(&path).map_err(|e| format!("could not read what is already at {}: {e}", path.display()))?)
        } else {
            None
        };
        match moving::plant_over(there.as_deref(), text.as_bytes()) {
            moving::Plant::Same => {}
            moving::Plant::Refuse => {
                return Err(format!(
                    "{} already holds a different copy of that conversation, and nothing was overwritten",
                    self.me
                ))
            }
            moving::Plant::Write => {
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| format!("could not make {}: {e}", parent.display()))?;
                }
                let tmp = path.with_extension("jsonl.arriving");
                std::fs::write(&tmp, text).map_err(|e| format!("could not write the conversation: {e}"))?;
                std::fs::rename(&tmp, &path).map_err(|e| format!("could not put the conversation in place: {e}"))?;
            }
        }

        /* The row and the lineage, before the card is opened — `#openIn`'s
           order. A birth row only for a card that has an origin to carry — the
           wall and card that asked for it, or its parent on the wall it left —
           because a birth row is what tells a card who opened it
           (`supervisor::Selfhood`), and a moved card with no origin was opened
           by nobody over there. It still counts against this wall's bounds on
           arriving work, through its move row (`here::arrivals_live`). */
        let now = self.now();
        let cwd = {
            let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
            let cwd = crate::store::arrive_row(
                &conn,
                &crate::store::Arrived {
                    id: &card.card,
                    session: &card.session,
                    root: &root,
                    worktree: card.worktree.as_deref(),
                    title: card.title.as_deref(),
                    named: card.named,
                    model: card.model.as_deref(),
                    effort: card.effort.as_deref(),
                    gear: card.gear.as_deref(),
                },
            )?;
            if let Some(o) = &card.origin {
                here::record_birth(&conn, &card.card, request, &o.host, o.card.as_deref(), now)?;
            }
            for child in &card.children {
                let _ = here::record_child(&conn, from, child, &card.card, request, now);
            }
            for a in &card.afar {
                let _ = here::record_child(&conn, &a.host, &a.card, &card.card, request, now);
            }
            cwd
        };
        let prompt = moving::confirm_prompt(
            crate::relay::RELAY_MARK,
            &Arrival {
                from,
                to: &self.me,
                territory: &card.territory,
                dir: &dir,
                code: &card.code,
                has_code,
                token,
                cue: &challenge.cue,
            },
        );
        if let Ok(mut c) = confirming().lock() {
            c.insert(card.card.clone(), request.to_string());
        }
        crate::chronicle::note(
            &self.app,
            None,
            "volery",
            "note",
            &format!("a card moved here from {from}, in {}", card.territory),
            &format!(
                "{} — checking it has its history before {from} lets its copy go",
                card.title.clone().unwrap_or_else(|| "untitled".into())
            ),
        );
        let _ = self.app.emit(
            "flyway:move-in",
            MoveIn {
                id: card.card.clone(),
                request: request.to_string(),
                cwd,
                worktree: card.worktree.clone(),
                session: card.session.clone(),
                title: card.title.clone(),
                model: card.model.clone(),
                effort: card.effort.clone(),
                prompt,
                from_host: from.to_string(),
            },
        );
        Ok(())
    }

    /// The move failed here: written down, the copy taken away if one was
    /// made, and said to the wall it came from.
    fn arrival_failed(self: &Arc<Self>, from: &str, request: &str, card: &str, why: &str) {
        let written = self
            .store()
            .and_then(|s| s.0.lock().ok().map(|c| here::settle_move(&c, request, "failed", Some(why), self.now())))
            .unwrap_or(false);
        if written {
            self.withdraw(card, &format!("it could not be moved here: {why}"));
            log::warn!("flyway: a card moving in from {from} did not arrive: {why}");
            self.tell_soon(request);
        }
    }

    /// The front end could not open the card it was handed.
    pub fn move_open_failed(self: &Arc<Self>, request: &str, why: &str) {
        let Some(row) = self.store().and_then(|s| s.0.lock().ok().and_then(|c| here::move_of(&c, request))) else {
            return;
        };
        if row.direction == "in" && row.outcome.is_none() {
            self.arrival_failed(&row.host, request, &row.card, &format!("the wall could not open it: {why}"));
        }
    }

    /// A turn has ended on a card proving it has its history. Settled only by
    /// an answer: a turn with none in it (an overload, a dropped stream) is left
    /// to be tried again, and the sweep settles a check never given.
    fn check(self: &Arc<Self>, card: &str, request: &str) {
        let Some(store) = self.store() else { return };
        let (row, text) = {
            let Ok(conn) = store.0.lock() else { return };
            let Some(row) = here::move_of(&conn, request) else { return };
            let Some((dir, session)) = crate::store::session_of(&conn, card) else { return };
            let session = session.unwrap_or_else(|| card.to_string());
            drop(conn);
            let Ok(path) = crate::supervisor::transcript_path(&self.app, &dir, &session) else { return };
            let Ok(text) = std::fs::read_to_string(path) else { return };
            (row, text)
        };
        if row.outcome.is_some() {
            return;
        }
        let (Some(challenge), Some(token)) = (
            row.challenge.as_deref().and_then(|c| serde_json::from_str::<Challenge>(c).ok()),
            row.token.as_deref(),
        ) else {
            return;
        };
        let Some(answer) = moving::answer_after(&text, token) else { return };
        let held = moving::held(&challenge, &answer);
        let (outcome, why) = if held {
            ("confirmed", None)
        } else {
            ("failed", Some("it could not finish its own line, so its history did not come with it".to_string()))
        };
        let written = store
            .0
            .lock()
            .map(|c| here::settle_move(&c, request, outcome, why.as_deref(), self.now()))
            .unwrap_or(false);
        if let Ok(mut c) = confirming().lock() {
            c.remove(card);
        }
        if !written {
            return;
        }
        if held {
            crate::chronicle::note(
                &self.app,
                None,
                "volery",
                "good",
                &format!("a card moved here from {} and has its history", row.host),
                "it finished a line from its own last message, from memory",
            );
        } else {
            self.withdraw(card, why.as_deref().unwrap_or("its check failed"));
        }
        self.tell_soon(request);
    }

    /// Take a card this wall was given back off it — closed, never deleted.
    fn withdraw(&self, card: &str, why: &str) {
        let _ = crate::supervisor::stop_unless_turning(&self.app, card);
        if let Ok(mut c) = confirming().lock() {
            c.remove(card);
        }
        if let Some(store) = self.store() {
            if let Ok(conn) = store.0.lock() {
                let _ = conn.execute(
                    "UPDATE conversation SET closed_at = ?2 WHERE id = ?1 AND closed_at IS NULL",
                    rusqlite::params![card, self.now()],
                );
            }
        }
        let _ = self.app.emit("flyway:move-withdraw", Withdrawn { id: card.to_string(), why: scrub(why) });
    }

    fn tell_soon(self: &Arc<Self>, request: &str) {
        let Some(row) = self.store().and_then(|s| s.0.lock().ok().and_then(|c| here::move_of(&c, request))) else {
            return;
        };
        let l = self.clone();
        tauri::async_runtime::spawn(async move { l.tell_move(row).await });
    }

    /// Say how a move in ended to the wall it came from, and act on its answer.
    async fn tell_move(self: Arc<Self>, row: MoveRow) {
        let Some(outcome) = row.outcome.clone() else { return };
        let ok = outcome == "confirmed";
        let Ok(peer) = self.wire.peer(&row.host) else { return };
        let m = MoveMsg::MoveSettled { id: row.request.clone(), card: row.card.clone(), ok, why: row.why.clone() };
        let Ok(back) = self.wire.exchange(peer, vec![Frame::Move(m)], true).await else {
            /* Said again on the next tick, until it lands or a day has gone. */
            return;
        };
        let mut released = None;
        let mut rest = Vec::new();
        for f in back {
            match f {
                Frame::Move(MoveMsg::MoveReleased { id, released: r, why }) if id == row.request => released = Some((r, why)),
                other => rest.push(other),
            }
        }
        let _ = self.take(rest, Some(row.host.as_str()));
        let Some((released, why)) = released else { return };
        let Some(store) = self.store() else { return };
        let untouched = if !released && ok {
            /* The other wall kept its own copy. This one goes only if nobody
               has spoken to it since its check — otherwise it holds somebody's
               words, and both copies stay, said on both walls. */
            store
                .0
                .lock()
                .ok()
                .and_then(|c| crate::store::session_of(&c, &row.card))
                .and_then(|(dir, session)| {
                    let session = session.unwrap_or_else(|| row.card.clone());
                    crate::supervisor::transcript_path(&self.app, &dir, &session).ok()
                })
                .and_then(|p| std::fs::read_to_string(p).ok())
                .is_some_and(|t| row.token.as_deref().is_some_and(|tok| moving::untouched_since(&t, tok)))
        } else {
            false
        };
        if let Ok(conn) = store.0.lock() {
            here::told_move(&conn, &row.request, self.now());
            if !released && ok && untouched {
                here::withdraw_move(&conn, &row.request, why.as_deref().unwrap_or("the other wall kept its copy"));
            }
        }
        if !released && ok {
            if untouched {
                self.withdraw(&row.card, &format!("{} kept its own copy, so this one is taken off", row.host));
            } else {
                crate::chronicle::note(
                    &self.app,
                    None,
                    "volery",
                    "note",
                    &format!("a card is on this wall and on {}", row.host),
                    &format!(
                        "{} kept its copy after this one had been spoken to, so both stay — close the one you do not want",
                        row.host
                    ),
                );
            }
        }
    }

    /// The tick's share: give up on moves out that nobody settled in time,
    /// fail arrivals whose check was never given, say every settled arrival
    /// again until it is answered, and forget parts that stopped arriving.
    pub(super) fn sweep_moves(self: &Arc<Self>) {
        let now = self.now();
        let Some(store) = self.store() else { return };
        let (open, untold) = {
            let Ok(conn) = store.0.lock() else { return };
            (here::moves_open(&conn), here::moves_untold(&conn))
        };
        for row in open {
            if row.direction == "out" {
                if moving::given_up(now, row.at) {
                    let why = format!(
                        "{} never said how the move ended within {} minutes, so the card stays here",
                        row.host,
                        moving::SETTLE_WITHIN_MS / 60_000
                    );
                    self.keep(&row.request, &row.card, &row.host, &why);
                }
                continue;
            }
            let ours = confirming().lock().ok().is_some_and(|c| c.get(&row.card) == Some(&row.request));
            let late = now.saturating_sub(row.at) > moving::CONFIRM_WITHIN_MS;
            if !ours || late {
                let why = if ours {
                    format!("it did not answer its check within {} minutes", moving::CONFIRM_WITHIN_MS / 60_000)
                } else {
                    "the wall restarted before it answered its check".to_string()
                };
                self.arrival_failed(&row.host, &row.request, &row.card, &why);
            }
        }
        for row in untold {
            if now.saturating_sub(row.at) > TELL_FOR_MS {
                if let Ok(conn) = store.0.lock() {
                    here::told_move(&conn, &row.request, now);
                }
                continue;
            }
            let l = self.clone();
            tauri::async_runtime::spawn(async move { l.tell_move(row).await });
        }
        if let Ok(mut a) = arriving().lock() {
            a.retain(|_, v| now.saturating_sub(v.since) <= moving::PARTS_WITHIN_MS);
        }
    }
}

/// What on this wall would be lost if the card's process stopped now — said as
/// the reason the move is refused, or `None`.
fn in_flight_here(conn: &rusqlite::Connection, card: &str) -> Option<String> {
    let count = |sql: &str| -> i64 { conn.query_row(sql, rusqlite::params![card], |r| r.get(0)).unwrap_or(0) };
    let jobs = count("SELECT COUNT(*) FROM job WHERE conversation_id = ?1");
    if jobs > 0 {
        return Some(format!(
            "it has {jobs} background job(s) running, which stop with its process here and do not come \
             with it — let them finish, then move it"
        ));
    }
    let unread = count("SELECT COUNT(*) FROM relay WHERE to_id = ?1 AND delivered_at IS NULL");
    if unread > 0 {
        return Some(format!(
            "it has {unread} message(s) it has not been given yet — wake it so it reads them, then move it"
        ));
    }
    let wakes = count("SELECT COUNT(*) FROM wake WHERE conversation_id = ?1");
    if wakes > 0 {
        return Some(
            "it asked to be woken later, and that wake is on this wall — let it come round, or cancel it, \
             then move it"
                .into(),
        );
    }
    let plans = count("SELECT COUNT(*) FROM timeline WHERE owner_id = ?1 AND state = 'live'");
    if plans > 0 {
        return Some("it has a timeline in flight on this wall — let it finish its plan, then move it".into());
    }
    None
}

/// An offer, made safe to act on: every string scrubbed, the ids that become a
/// file name or a key checked for shape, the branch checked as an argument to
/// git, the model and effort held to this wall's own words, the gear held to
/// the one this wall reads.
fn clean(mut c: Moving) -> Result<Moving, String> {
    c.card = scrub(c.card.trim());
    c.session = scrub(c.session.trim());
    if !plain_id(&c.card) || !plain_id(&c.session) {
        return Err("the card's id or its session is not one this wall can file".into());
    }
    c.title = c.title.map(|t| scrub(&t).chars().take(120).collect());
    c.territory = scrub(&c.territory);
    c.code.sha = scrub(c.code.sha.trim());
    if !c.code.sha.chars().all(|ch| ch.is_ascii_hexdigit()) || c.code.sha.len() < 7 || c.code.sha.len() > 64 {
        return Err("the commit it left at is not one git could name".into());
    }
    c.code.branch = c.code.branch.map(|b| scrub(&b)).filter(|b| plain_branch(b));
    if let Some(w) = c.worktree.as_deref() {
        if !plain_branch(w) {
            return Err("its branch is not a name this wall will hand to git".into());
        }
    }
    /* The row's own words, not `spawn`'s family names: a card's row holds what
       its preset resolved to (`opus[1m]`, a full id), and it goes to `--model`
       as an argument rather than through a shell. So it is held to a shape —
       a model id's characters — and the CLI says the rest. The effort is one
       of the five or nothing. */
    c.model = c.model.map(|m| scrub(m.trim())).filter(|m| {
        !m.is_empty() && m.len() <= 64 && m.chars().all(|ch| ch.is_ascii_alphanumeric() || "-_.[]".contains(ch))
    });
    c.effort = c.effort.map(|e| e.trim().to_ascii_lowercase()).filter(|e| crate::spawn::SPAWN_EFFORTS.contains(&e.as_str()));
    c.gear = c.gear.filter(|g| g == "plan");
    if let Some(o) = &mut c.origin {
        o.host = scrub(&o.host);
        o.card = o.card.as_deref().map(scrub).filter(|k| plain_id(k));
    }
    c.children.retain(|k| plain_id(k));
    c.afar.retain(|a| plain_id(&a.card));
    for a in &mut c.afar {
        a.host = scrub(&a.host);
    }
    Ok(c)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A card coming back to a wall it once left has a closed row there, and
    /// `record_row`'s `OR IGNORE` would leave it closed — on the wall today,
    /// gone at the next launch. The arrival opens it again, on its own session.
    #[test]
    fn a_card_arriving_where_it_once_was_is_opened_again_on_its_own_session() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::store::migrate(&conn).unwrap();
        let a = crate::store::Arrived {
            id: "c-1",
            session: "s-9",
            root: "C:/nowhere/skein",
            worktree: None,
            title: Some("t"),
            named: true,
            model: Some("opus[1m]"),
            effort: Some("high"),
            gear: Some("plan"),
        };
        crate::store::arrive_row(&conn, &a).unwrap();
        conn.execute("UPDATE conversation SET closed_at = 5, agent_session_id = 'old' WHERE id = 'c-1'", []).unwrap();
        crate::store::arrive_row(&conn, &a).unwrap();
        let got: (Option<i64>, String, Option<String>, String, i64, String) = conn
            .query_row(
                "SELECT closed_at, agent_session_id, last_ending, kind, named_by_hand, permission_mode FROM conversation WHERE id = 'c-1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
            )
            .unwrap();
        assert_eq!(got, (None, "s-9".into(), Some("ok".into()), "project".into(), 1, "plan".into()));
    }

    #[test]
    fn an_id_that_becomes_a_file_name_is_only_letters_digits_and_dashes() {
        assert!(plain_id("0cf05791-aaaa-4bbb-8ccc-000000000001"));
        for bad in ["", "../x", "a/b", "a\\b", "a b", "x.jsonl", &"a".repeat(65)] {
            assert!(!plain_id(bad), "{bad:?}");
        }
    }

    #[test]
    fn a_branch_is_never_an_option_or_a_path_escape() {
        assert!(plain_branch("feat/async-auth"));
        for bad in ["", "-x", "--upload-pack=evil", "a..b", "a b", "a\u{0}b", "a:b", "a\\b"] {
            assert!(!plain_branch(bad), "{bad:?}");
        }
    }

    fn offer() -> Moving {
        Moving {
            card: "c-1".into(),
            session: "s-1".into(),
            title: Some("a\u{0}b".into()),
            named: true,
            model: Some("sonnet".into()),
            effort: None,
            gear: Some("bypassPermissions".into()),
            worktree: None,
            territory: "skein".into(),
            code: Code { sha: "0123456789abcdef".into(), branch: Some("main".into()) },
            origin: None,
            children: vec!["kid-1".into(), "../evil".into()],
            afar: vec![],
            parts: 1,
            bytes: 1,
        }
    }

    /// What arrives is made safe before anything acts on it: scrubbed, shaped,
    /// held to this wall's words — and a gear that is not planning is making,
    /// which is what this wall reads every other gear as.
    #[test]
    fn an_offer_is_cleaned_before_it_is_trusted_with_anything() {
        let c = clean(offer()).unwrap();
        assert_eq!(c.title.as_deref(), Some("ab"));
        assert_eq!(c.gear, None);
        assert_eq!(c.children, vec!["kid-1".to_string()]);
        let mut bad = offer();
        bad.session = "../../../Windows/x".into();
        assert!(clean(bad).is_err());
        let mut bad = offer();
        bad.code.sha = "HEAD; rm -rf".into();
        assert!(clean(bad).is_err());
        let mut bad = offer();
        bad.worktree = Some("--orphan".into());
        assert!(clean(bad).is_err());
        let mut odd = offer();
        odd.model = Some("opus[1m]".into());
        odd.effort = Some("HIGH".into());
        let c = clean(odd).unwrap();
        assert_eq!((c.model.as_deref(), c.effort.as_deref()), (Some("opus[1m]"), Some("high")), "a row's own words travel");
        let mut odd = offer();
        odd.model = Some("opus --dangerous".into());
        odd.effort = Some("ludicrous".into());
        let c = clean(odd).unwrap();
        assert_eq!((c.model, c.effort), (None, None), "and what is not one is the machine's own setting");
    }
}
