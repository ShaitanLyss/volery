//! What each wall's billboard says, carried to the walls it flies with — and a
//! notice taken down from another wall.
//!
//! `board.rs` is the billboard and decides everything about what a notice
//! *means*. This is the carrying, and it is pure: what one wall says about its
//! own notices, what another holds of it, and the one exchange that asks a wall
//! to take one of its notices down. `link/boards.rs` is the wiring.
//!
//! ### Why the board crosses at all, when it was written as one wall's
//!
//! `sink.md` used to set the board against the sink as opposites, and part of
//! that argument was that a notice is about *now*, in one working tree, held by
//! live processes, where a finding is about the code, which two checkouts share
//! through git. That is still true of a notice that claims files. It was never
//! true of one that names none — *"don't push to this repo"*, *"Lyss is away
//! next week, we are wrapping up"* — which is standing context for every card
//! everywhere. And remote spawn made a second case ordinary: **an orchestrator
//! on one machine with its workers on another could not post a notice its own
//! children would see**, nor take one down, so the one coordination mechanism
//! the wall has did not reach the cards it most needed to reach. An exclusion
//! justified by "these two things do not interact" expires silently the moment
//! somebody makes them interact; the flyway did.
//!
//! ### The home wall is the authority, and what crosses is a picture of it
//!
//! A notice lives in the store of the wall its author stands on — a card's
//! wall, or the wall a person typed it on. That wall says the whole of its
//! board on every exchange and within a second of any change, and a peer holds
//! the newest picture per host and **never writes a notice of its own from
//! one**. So every clearing `board.md` lists — a card closing, a card cleared,
//! three days of silence, its author's `unpost`, a person's ✕ — is done where
//! the notice lives and reaches every other wall by the next picture, with no
//! event vocabulary per mechanism and nothing that could leave two walls
//! disagreeing about whether a notice is up.
//!
//! That is the sink's opposite on purpose. The sink ships *events* because
//! many walls write to one pile and must converge (`sync.rs`'s voices). A
//! notice has exactly one writer, its author, on its home wall — there is
//! nothing to converge, and a picture replaced whole cannot diverge.
//!
//! ### A version that moves when the words do
//!
//! The picture is built fresh every time it is said, because the board lives in
//! SQLite and is true from launch — there is no front end to wait for, which is
//! the half of `cards.rs` that does not carry over. Its version rises only when
//! what it says changes (`say`), and is persisted for `cards.rs`'s reason: a
//! wall restarted after its clock went backwards would otherwise say versions
//! every peer has passed, and its board would freeze over there. A repeat of
//! the version a peer holds is still taken, for its ages — see `on`.
//!
//! ### Ages, so no two clocks are compared
//!
//! Each notice says how long ago it was posted and how long nobody has been
//! behind it (`board::quiet_ms`, the later of its touch and its author's last
//! turn) **at the moment it was said**. The holder adds its own clock's time
//! since hearing it. So a stale mark on the far wall is the home wall's own
//! reading, carried forward, and goes on ripening while the home wall is out of
//! reach — which is what lets the copy expire on the clock the home wall would
//! have used, when nothing can sweep it from there.
//!
//! ### Not relayed, and not kept across a restart
//!
//! `cards.rs`'s two reasons, both unchanged: a third wall passing on what the
//! laptop's board looked like an hour ago is history, not a board; and every
//! wall dials every wall, so a relay would reach nobody a dial does not. Held in
//! memory, as a shadow is — a wall restarted while another is quiet shows that
//! wall's notices again when it is next heard, within one exchange.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// What a wall announces in `Facts::can` when it says its billboard and takes
/// an `unpost` from another wall.
pub const WORD: &str = "board";

/// The most one wall's picture may weigh, serialised. A notice is at most a
/// few kilobytes and a card may have eight up; this is a bound on what a
/// confused peer can make us hold, not a budget an honest board approaches.
pub const MAX_BOARD: usize = 192 * 1024;

/* What crosses is bounded on the way in, against another build. The home
   wall's own caps are tighter (`board::MAX_SUBJECT`, `MAX_BODY`, `MAX_GLOBS`)
   but a clipped notice carries the wall's marker after its text, so these
   leave room for that and are not a second statement of the board's caps. */
const SUBJECT_MOST: usize = 400;
const BODY_MOST: usize = 6_000;
const NAME_MOST: usize = 120;
const GLOB_MOST: usize = 300;
const GLOBS_MOST: usize = 32;
const NOTICES_MOST: usize = 500;

/// The most a refusal from another wall may say. `board::still_theirs` is the
/// longest, at well under half of this.
pub const WHY_MOST: usize = 2_000;

/// One notice, as its home wall says it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Posted {
    pub id: String,
    /// `project` or `skein`, as `store::Notice::scope`.
    pub scope: String,
    /// The project's **name** — the one thing two checkouts of a repository
    /// share without a registry, and `sinksync::scope_of`'s choice for the
    /// same reason. `None` for a wall-wide notice.
    #[serde(default)]
    pub project: Option<String>,
    /// The card that posted it, `None` when a person did.
    #[serde(default)]
    pub from: Option<String>,
    /// What that card is called on its own wall.
    #[serde(default)]
    pub title: Option<String>,
    pub subject: String,
    pub body: String,
    #[serde(default)]
    pub paths: Vec<String>,
    /// How long ago it went up, when it was said.
    #[serde(default)]
    pub posted_ms: u64,
    /// How long nobody had been behind it, when it was said — `board::quiet_ms`
    /// on its home wall, which is what its stale mark and its expiry turn on.
    #[serde(default)]
    pub quiet_ms: u64,
}

/// A card asking another wall to take one of its notices down.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Taker {
    /// The asking card's id on its own wall.
    pub card: String,
    /// What it is called there, for the words.
    pub title: String,
}

/// What a home wall says when a card elsewhere may only have its notice taken
/// down by a person: everything the question needs, read fresh there.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Retiring {
    pub subject: String,
    pub body: String,
    #[serde(default)]
    pub paths: Vec<String>,
    /// The card that posted it, as its home wall calls it.
    pub title: String,
    pub card: String,
    pub quiet_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "msg", rename_all = "snake_case")]
pub enum BoardMsg {
    /// One wall's billboard, whole. `withheld` is how many of its notices did
    /// not fit `MAX_BOARD`, said rather than dropped.
    Board {
        host: String,
        version: u64,
        #[serde(default)]
        withheld: u32,
        notices: Vec<Posted>,
    },
    /// Take notice `notice` down, or — for a card that is not its author —
    /// say whether it may be. `by` is `None` for a person, who may take down
    /// anything; `confirm` is a card's second ask, sent only once a person has
    /// answered yes on the asking wall.
    Unpost {
        id: String,
        notice: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        by: Option<Taker>,
        #[serde(default)]
        confirm: bool,
    },
    /// `taken`, `gone` (it was not up), `ask` (only a person may say), or
    /// anything else with a reason. A string rather than an enum for
    /// `act::ActMsg`'s reason: a newer build's outcome must read as a refusal
    /// here, not fail the frame.
    Unposted {
        id: String,
        outcome: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        why: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ask: Option<Retiring>,
    },
}

/// The three tags this vocabulary writes, for `frame::KNOWN`'s test.
pub const TAGS: [&str; 3] = ["board", "unpost", "unposted"];

/// What a home wall decided about an `unpost`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reply {
    /// It came down.
    Taken,
    /// It was not up — already taken down, or never there.
    Gone,
    /// Its card is not there to be asked and has been quiet for hours: a
    /// person may say, and here is what to show them.
    Ask(Retiring),
}

/// A notice another wall holds up, with its ages advanced to now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Seen {
    pub host: String,
    pub notice: Posted,
    /// How long since this wall last heard that wall's board.
    pub heard_ms: u64,
}

/// A picture as this wall holds it.
#[derive(Debug, Clone)]
struct Held {
    version: u64,
    /// When it was heard, on this wall's clock — the ages are advanced from it.
    heard_at: i64,
    withheld: u32,
    notices: Vec<Posted>,
}

pub struct Boards {
    me: String,
    last_version: u64,
    /// What this wall last said, ages left out, so a repeat keeps its version.
    said: Option<String>,
    theirs: BTreeMap<String, Held>,
}

impl Boards {
    /// `last_version` is what `version()` returned the last time this wall ran.
    pub fn new(me: &str, last_version: u64) -> Self {
        Self { me: me.to_string(), last_version, said: None, theirs: BTreeMap::new() }
    }

    pub fn version(&self) -> u64 {
        self.last_version
    }

    /// This wall's board as it stands now, under a version that rises only
    /// when what it says has changed. The second value is whether it rose, so
    /// the caller knows to persist it.
    ///
    /// Too much for one picture is said rather than cut: the notices most
    /// recently stood behind go first, and the count of the rest travels as
    /// `withheld`, so the far wall can say that some of this wall's board did
    /// not reach it rather than drawing a short board as a whole one.
    pub fn say(&mut self, notices: Vec<Posted>, now: i64) -> (BoardMsg, bool) {
        let (notices, withheld) = fit(notices);
        let key = content_key(&notices, withheld);
        let moved = self.said.as_deref() != Some(key.as_str());
        if moved {
            self.last_version = (now.max(0) as u64).max(self.last_version.saturating_add(1));
            self.said = Some(key);
        }
        (BoardMsg::Board { host: self.me.clone(), version: self.last_version, withheld, notices }, moved)
    }

    /// Fold a peer's picture in. True if what it says changed — the cue to
    /// redraw — and false for a repeat, which still refreshes its ages.
    ///
    /// **A repeat is taken, unlike `cards.rs`.** The version moves only with
    /// the words, so a peer re-saying the same board every exchange is the
    /// ordinary case — and its ages are the point of saying it again: a notice
    /// whose author took a turn a minute ago is not stale, and a holder that
    /// kept the first copy's ages would go on counting from then.
    pub fn on(&mut self, m: BoardMsg, now: i64) -> bool {
        let BoardMsg::Board { host, version, withheld, notices } = m else {
            return false;
        };
        let host = crate::clean::scrub(&host).into_owned();
        /* An echo or a namesake — `cards.rs`'s reason. */
        if host == self.me || host.is_empty() {
            return false;
        }
        /* Twice what an honest wall says (`fit`), so a build with slightly
           different caps is still heard and a confused one is not held. */
        if serde_json::to_vec(&notices).map(|b| b.len()).unwrap_or(usize::MAX) > MAX_BOARD * 2 {
            return false;
        }
        let held = self.theirs.get(&host).map(|h| h.version);
        if held.is_some_and(|v| v > version) {
            return false;
        }
        let notices: Vec<Posted> = notices.into_iter().take(NOTICES_MOST).filter_map(cleaned).collect();
        let news = held != Some(version);
        self.theirs.insert(host, Held { version, heard_at: now, withheld, notices });
        news
    }

    /// Every notice another wall holds up, ages advanced to `now`.
    pub fn seen(&self, now: i64) -> Vec<Seen> {
        let mut out = Vec::new();
        for (host, h) in &self.theirs {
            let since = now.saturating_sub(h.heard_at).max(0) as u64;
            for n in &h.notices {
                let mut n = n.clone();
                n.posted_ms = n.posted_ms.saturating_add(since);
                n.quiet_ms = n.quiet_ms.saturating_add(since);
                out.push(Seen { host: host.clone(), notice: n, heard_ms: since });
            }
        }
        out
    }

    /// How many of each wall's notices did not fit its picture.
    pub fn withheld(&self) -> Vec<(String, u32)> {
        self.theirs.iter().filter(|(_, h)| h.withheld > 0).map(|(k, h)| (k.clone(), h.withheld)).collect()
    }

    /// Take a wall off — when a person forgets it from the roster.
    pub fn forget(&mut self, host: &str) {
        self.theirs.remove(host);
    }
}

/// The notices that fit one picture, and how many did not.
fn fit(notices: Vec<Posted>) -> (Vec<Posted>, u32) {
    let size = |n: &Posted| serde_json::to_vec(n).map(|b| b.len()).unwrap_or(usize::MAX);
    if notices.iter().map(size).sum::<usize>() <= MAX_BOARD {
        return (notices, 0);
    }
    /* The most recently stood behind first: the notice somebody is still
       making is the one worth carrying. Then put back in the board's order. */
    let mut order: Vec<usize> = (0..notices.len()).collect();
    order.sort_by_key(|&i| notices[i].quiet_ms);
    let mut keep = vec![false; notices.len()];
    let mut used = 0usize;
    for i in order {
        let s = size(&notices[i]);
        if used + s <= MAX_BOARD {
            used += s;
            keep[i] = true;
        }
    }
    let withheld = keep.iter().filter(|k| !**k).count() as u32;
    let kept = notices.into_iter().zip(keep).filter(|(_, k)| *k).map(|(n, _)| n).collect();
    (kept, withheld)
}

/// What a picture says, without the ages that change every time it is said.
fn content_key(notices: &[Posted], withheld: u32) -> String {
    let bare: Vec<Posted> = notices.iter().cloned().map(|mut n| {
        n.posted_ms = 0;
        n.quiet_ms = 0;
        n
    }).collect();
    format!("{withheld}:{}", serde_json::to_string(&bare).unwrap_or_default())
}

/// Words from another wall, made safe to hold and to hand to a card:
/// scrubbed of what an agent could not send, and capped — `sinksync::clean`'s
/// shape, since this too is a text somebody else will read.
fn clean(s: &str, max: usize) -> String {
    crate::clip::keep(&crate::clean::scrub(s.trim()), max).kept
}

/// A notice off the wire, or `None` if it is not one this app could have
/// written: no id in a uuid's alphabet, or nothing to say.
fn cleaned(n: Posted) -> Option<Posted> {
    if !super::act::is_id(&n.id) {
        return None;
    }
    let subject = clean(&n.subject, SUBJECT_MOST);
    if subject.is_empty() {
        return None;
    }
    let name = |s: Option<String>| s.map(|s| clean(&s, NAME_MOST)).filter(|s| !s.is_empty());
    /* A scope this build does not know, or a project scope with no project,
       reads as wall-wide: shown to more cards rather than fewer, which is the
       side a board should err on — the sink lands an unknown scope the same
       way. */
    let project = name(n.project);
    let scope = if n.scope == "project" && project.is_some() { "project" } else { "skein" };
    Some(Posted {
        id: n.id,
        scope: scope.to_string(),
        project: if scope == "project" { project } else { None },
        from: n.from.filter(|f| super::act::is_id(f)),
        title: name(n.title),
        subject,
        body: clean(&n.body, BODY_MOST),
        paths: n
            .paths
            .iter()
            .map(|g| clean(g, GLOB_MOST))
            .filter(|g| !g.is_empty())
            .take(GLOBS_MOST)
            .collect(),
        posted_ms: n.posted_ms,
        quiet_ms: n.quiet_ms,
    })
}

/// The answer to an `unpost`, bounded on the way out.
pub fn unposted(id: &str, r: Result<Reply, String>) -> BoardMsg {
    let (outcome, why, ask) = match r {
        Ok(Reply::Taken) => ("taken", None, None),
        Ok(Reply::Gone) => ("gone", None, None),
        Ok(Reply::Ask(a)) => ("ask", None, Some(a)),
        Err(why) => ("refused", Some(clean(&why, WHY_MOST)), None),
    };
    BoardMsg::Unposted { id: id.to_string(), outcome: outcome.into(), why, ask }
}

/// Read the home wall's answer to the request `id` out of everything the
/// exchange brought back. Bounded again here — the far wall is another build.
pub fn answer_in<'a>(frames: impl IntoIterator<Item = &'a BoardMsg>, id: &str, host: &str) -> Result<Reply, String> {
    let found = frames.into_iter().find_map(|m| match m {
        BoardMsg::Unposted { id: i, outcome, why, ask } if i == id => Some((outcome, why, ask)),
        _ => None,
    });
    match found {
        None => Err(format!(
            "{host} did not answer — the notice may or may not have come down; read the board again before asking"
        )),
        Some((o, _, _)) if o == "taken" => Ok(Reply::Taken),
        Some((o, _, _)) if o == "gone" => Ok(Reply::Gone),
        Some((o, _, Some(a))) if o == "ask" => {
            let a = a.clone();
            Ok(Reply::Ask(Retiring {
                subject: clean(&a.subject, SUBJECT_MOST),
                body: clean(&a.body, BODY_MOST),
                paths: a.paths.iter().map(|g| clean(g, GLOB_MOST)).filter(|g| !g.is_empty()).take(GLOBS_MOST).collect(),
                title: clean(&a.title, NAME_MOST),
                card: if super::act::is_id(&a.card) { a.card } else { String::new() },
                quiet_ms: a.quiet_ms,
            }))
        }
        Some((_, why, _)) => {
            let why = why.as_deref().map(|w| clean(w, WHY_MOST)).unwrap_or_default();
            Err(if why.is_empty() { format!("{host} would not take it down") } else { why })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "aaaaaaaa-1111-4111-8111-111111111111";
    const CARD: &str = "bbbbbbbb-2222-4222-8222-222222222222";

    fn posted(subject: &str, quiet: u64) -> Posted {
        Posted {
            id: ID.into(),
            scope: "skein".into(),
            project: None,
            from: Some(CARD.into()),
            title: Some("the orchestrator".into()),
            subject: subject.into(),
            body: "do not push to this repo".into(),
            paths: vec![],
            posted_ms: 1_000,
            quiet_ms: quiet,
        }
    }

    fn said(b: &mut Boards, notices: Vec<Posted>, now: i64) -> BoardMsg {
        b.say(notices, now).0
    }

    /// The whole of the orchestrator's case: posted on one wall, seen on the
    /// other, and gone from the other once it is gone from the first.
    #[test]
    fn a_notice_crosses_and_its_absence_crosses_too() {
        let mut desk = Boards::new("desk", 0);
        let mut lap = Boards::new("lap", 0);
        assert!(lap.on(said(&mut desk, vec![posted("wrapping up", 0)], 10), 100));
        let seen = lap.seen(100);
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].host, "desk");
        assert_eq!(seen[0].notice.subject, "wrapping up");
        /* Taken down at home: the next picture is empty, and that is news. */
        assert!(lap.on(said(&mut desk, vec![], 20), 200));
        assert!(lap.seen(200).is_empty(), "an empty board is a true board");
    }

    /// The version moves with the words and not with the clock, so a peer
    /// re-saying its board every exchange is not news each time — and the
    /// repeat still refreshes the ages, which is why it is said.
    #[test]
    fn a_repeat_keeps_its_version_and_refreshes_its_ages() {
        let mut desk = Boards::new("desk", 0);
        let (first, moved) = desk.say(vec![posted("s", 5_000)], 10);
        assert!(moved);
        let (again, moved) = desk.say(vec![posted("s", 60)], 40);
        assert!(!moved, "same words, same version");
        match (&first, &again) {
            (BoardMsg::Board { version: a, .. }, BoardMsg::Board { version: b, .. }) => assert_eq!(a, b),
            _ => unreachable!(),
        }
        let mut lap = Boards::new("lap", 0);
        assert!(lap.on(first, 0));
        assert!(!lap.on(again, 1_000), "a repeat is not news");
        /* But the author has taken a turn since, and the holder knows it. */
        assert_eq!(lap.seen(1_000)[0].notice.quiet_ms, 60);
        /* New words are a new version. */
        let (_, moved) = desk.say(vec![posted("s2", 0)], 50);
        assert!(moved);
    }

    /// A slow push overtaken by a tick must not put back a board that has
    /// since changed — the notice an orchestrator took down would reappear.
    #[test]
    fn an_older_picture_never_replaces_a_newer_one() {
        let mut desk = Boards::new("desk", 0);
        let mut lap = Boards::new("lap", 0);
        let old = said(&mut desk, vec![posted("s", 0)], 100);
        let new = said(&mut desk, vec![], 200);
        assert!(lap.on(new, 300));
        assert!(!lap.on(old, 300));
        assert!(lap.seen(300).is_empty());
    }

    /// While the home wall is out of reach its notices go on ageing here, on
    /// the clock it would have used — the copy's stale mark and its expiry
    /// need nothing from a machine that is not there.
    #[test]
    fn a_held_notice_goes_on_ageing_while_its_wall_is_silent() {
        let mut desk = Boards::new("desk", 0);
        let mut lap = Boards::new("lap", 0);
        lap.on(said(&mut desk, vec![posted("s", 7_000)], 0), 50_000);
        let s = &lap.seen(50_000 + 3_600_000)[0];
        assert_eq!(s.notice.quiet_ms, 7_000 + 3_600_000);
        assert_eq!(s.notice.posted_ms, 1_000 + 3_600_000);
        assert_eq!(s.heard_ms, 3_600_000);
    }

    /// The restart after a clock correction: the persisted version carries on
    /// rising even when the clock does not.
    #[test]
    fn a_restart_with_a_slow_clock_still_says_newer() {
        let mut before = Boards::new("desk", 0);
        before.say(vec![posted("s", 0)], 5_000_000);
        let mut after = Boards::new("desk", before.version());
        after.say(vec![posted("s", 0)], 1_000);
        assert!(after.version() > before.version());
    }

    #[test]
    fn an_echo_of_this_wall_is_not_held() {
        let mut desk = Boards::new("desk", 0);
        let mine = said(&mut desk, vec![posted("s", 0)], 0);
        assert!(!desk.on(mine, 0));
        assert!(desk.seen(0).is_empty());
    }

    /// Too much for one picture is said, not cut: the notices somebody is
    /// still behind go, and the count of the rest travels with them.
    #[test]
    fn a_board_too_large_says_how_much_did_not_fit() {
        let big = |i: usize, quiet: u64| {
            let mut p = posted(&format!("n{i}"), quiet);
            p.id = format!("{i:08}-1111-4111-8111-111111111111");
            p.body = "x".repeat(40_000);
            p
        };
        let notices: Vec<Posted> = (0..8).map(|i| big(i, (8 - i) as u64)).collect();
        let mut desk = Boards::new("desk", 0);
        let BoardMsg::Board { notices: kept, withheld, .. } = said(&mut desk, notices, 0) else { unreachable!() };
        assert!(withheld > 0);
        assert_eq!(kept.len() + withheld as usize, 8);
        /* The freshest were kept — n7 is the one stood behind most recently. */
        assert!(kept.iter().any(|n| n.subject == "n7"));
        assert!(!kept.iter().any(|n| n.subject == "n0"));
        let mut lap = Boards::new("lap", 0);
        lap.on(said(&mut desk, (0..8).map(|i| big(i, (8 - i) as u64)).collect(), 1), 0);
        assert_eq!(lap.withheld(), vec![("desk".to_string(), withheld)]);
    }

    /// What arrives is a text a card will read, so it is scrubbed and capped,
    /// and a notice no build of this app could have written is not held.
    #[test]
    fn what_arrives_is_scrubbed_bounded_and_ours() {
        let mut lap = Boards::new("lap", 0);
        let mut odd = posted("bro\u{7}ken", 0);
        odd.body = format!("a\u{0}b{}", "z".repeat(BODY_MOST * 2));
        odd.paths = vec!["src/\u{1b}x.rs".into(), "  ".into()];
        odd.scope = "galaxy".into();
        let mut no_id = posted("x", 0);
        no_id.id = "../etc".into();
        let mut blank = posted("   ", 0);
        blank.id = CARD.into();
        let m = BoardMsg::Board { host: "de\u{0}sk".into(), version: 1, withheld: 0, notices: vec![odd, no_id, blank] };
        assert!(lap.on(m, 0));
        let seen = lap.seen(0);
        assert_eq!(seen.len(), 1, "{seen:?}");
        let n = &seen[0].notice;
        assert_eq!(seen[0].host, "desk");
        assert_eq!(n.subject, "broken");
        assert!(n.body.starts_with("ab") && !n.body.contains('\u{0}'));
        assert!(n.body.chars().count() < BODY_MOST * 2);
        assert_eq!(n.paths, vec!["src/x.rs".to_string()]);
        /* An unknown scope reads as wall-wide — shown to more, not fewer. */
        assert_eq!(n.scope, "skein");
    }

    #[test]
    fn a_project_notice_keeps_its_project_and_one_without_is_wall_wide() {
        let mut lap = Boards::new("lap", 0);
        let mut p = posted("s", 0);
        p.scope = "project".into();
        p.project = Some("skein".into());
        let mut q = posted("t", 0);
        q.id = CARD.into();
        q.scope = "project".into();
        lap.on(BoardMsg::Board { host: "desk".into(), version: 1, withheld: 0, notices: vec![p, q] }, 0);
        let seen = lap.seen(0);
        assert_eq!((seen[0].notice.scope.as_str(), seen[0].notice.project.as_deref()), ("project", Some("skein")));
        assert_eq!((seen[1].notice.scope.as_str(), seen[1].notice.project.as_deref()), ("skein", None));
    }

    /// Taken, gone, a question, or a reason — and the two non-answers: a wall
    /// that said nothing, and an outcome this build has no word for, which is
    /// refused, the safe direction.
    #[test]
    fn an_answer_is_one_of_four_and_anything_else_is_a_refusal() {
        let r = |o: &str| BoardMsg::Unposted { id: "r".into(), outcome: o.into(), why: None, ask: None };
        assert_eq!(answer_in([&r("taken")], "r", "desk"), Ok(Reply::Taken));
        assert_eq!(answer_in([&r("gone")], "r", "desk"), Ok(Reply::Gone));
        assert_eq!(answer_in([&r("archived")], "r", "desk"), Err("desk would not take it down".into()));
        assert!(answer_in([&r("taken")], "other", "desk").unwrap_err().contains("may or may not"));
        let no = unposted("r", Err(format!("not yours\u{7}{}", "w".repeat(WHY_MOST))));
        let why = answer_in([&no], "r", "desk").unwrap_err();
        assert!(why.starts_with("not yours") && !why.contains('\u{7}'));
        let a = Retiring {
            subject: "s".into(),
            body: "b".into(),
            paths: vec!["x.rs".into()],
            title: "t".into(),
            card: CARD.into(),
            quiet_ms: 9,
        };
        assert_eq!(answer_in([&unposted("r", Ok(Reply::Ask(a.clone())))], "r", "desk"), Ok(Reply::Ask(a)));
        /* An `ask` with nothing to show is not a question anybody can answer. */
        assert!(answer_in([&r("ask")], "r", "desk").is_err());
    }

    /// The words survive the wire, an older asker's frame with no `by` or
    /// `confirm` reads as a person's first ask, and a newer field is free.
    #[test]
    fn the_words_round_trip_and_a_newer_field_is_free() {
        for m in [
            BoardMsg::Board { host: "desk".into(), version: 3, withheld: 1, notices: vec![posted("s", 0)] },
            BoardMsg::Unpost {
                id: "r".into(),
                notice: ID.into(),
                by: Some(Taker { card: CARD.into(), title: "t".into() }),
                confirm: true,
            },
            unposted("r", Ok(Reply::Gone)),
            unposted("r", Err("no".into())),
        ] {
            let back: BoardMsg = serde_json::from_value(serde_json::to_value(&m).unwrap()).unwrap();
            assert_eq!(back, m);
        }
        let bare: BoardMsg = serde_json::from_value(serde_json::json!({ "msg": "unpost", "id": "r", "notice": ID })).unwrap();
        assert!(matches!(bare, BoardMsg::Unpost { by: None, confirm: false, .. }));
        let newer: BoardMsg = serde_json::from_value(serde_json::json!({
            "msg": "board", "host": "desk", "version": 1, "later": true,
            "notices": [{ "id": ID, "scope": "skein", "subject": "s", "body": "b", "pinned": 1 }]
        }))
        .unwrap();
        assert!(matches!(newer, BoardMsg::Board { withheld: 0, .. }));
    }

    #[test]
    fn the_tags_are_the_ones_the_enum_writes() {
        let written: Vec<String> = [
            BoardMsg::Board { host: String::new(), version: 0, withheld: 0, notices: vec![] },
            BoardMsg::Unpost { id: String::new(), notice: String::new(), by: None, confirm: false },
            unposted("", Ok(Reply::Taken)),
        ]
        .iter()
        .map(|m| serde_json::to_value(m).unwrap()["msg"].as_str().unwrap().to_string())
        .collect();
        assert_eq!(written, TAGS.map(str::to_string).to_vec());
    }
}
