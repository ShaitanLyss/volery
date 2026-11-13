//! Whether the wall's allowance admits new work right now — the one fact a
//! fan-out, a wake and a stop notice all need before they spend a turn.
//!
//! **What this file decides and what it does not.** Which account takes the
//! next turn is `accounts.ts::choose` and `credits.ts::route`, in the front end,
//! and nothing here re-decides it: the caps, the tiers, the refusals the stream
//! has heard and boost all live there, and a second copy of that policy in Rust
//! is the drift `spawn.md` warns about every time a decision crosses an `emit`.
//! What the front end *says* is the outcome, as it changes (`note_allowance`,
//! `quit::note_busy`'s shape and `credits::note_boost`'s): whether the ladder
//! would hold a new card — with and without a card's own bypass of your caps —
//! and if not, which account it would land on and how close that account's
//! five-hour window is to its ceiling, for a card with no preference and for one
//! asked onto each account. This file only reads that against the two things
//! Rust alone can see — which cards are mid-turn on which account, and what is
//! about to be handed a turn.
//!
//! **The two failures it exists for**, both measured on 2026-10-30
//! (`.scratch-12fa2a91/`): a Remote Desktop fan-out of five and the RISE
//! coordinator all hit "You've hit your 5-hour limit" within minutes of each
//! other, twice in a day, and then paid a cold full-context cache rewrite
//! together at the reset; and the coordinator was handed eighteen turns that were
//! "cut off — allowance ran out" and seventeen that "never reached a model".
//! Sink d08fa95e and d0a91bf0.
//!
//! - **A wake, or a parent's stop notice, waits while every account is spent**
//!   (`held_for`). It is held, never dropped: the wake row stays due and is
//!   served once the wall says there is room, and a settle stays pending.
//!   `turns.md`'s rule for a nudge — "a card with no allowance is not nudged
//!   either; a deferred nudge is put back, not dropped" — carried to the two
//!   prompts Rust writes on its own initiative.
//! - **A spawn queues when the five-hour window of the account it would land on
//!   is past [`CEILING`] and other cards are working on that account**
//!   (`verdict`). The card still opens — Lyss, 2026-11-02: visible, with its
//!   brief held — so it can be seen, cancelled or let go, and it starts when the
//!   window resets, when another account frees up, or when nothing else on its
//!   account is working. Running work finishes before new work starts, which is
//!   what keeps a window from ending with N half-done contexts that all re-pay
//!   their cache writes at once.
//! - **A plan's pace holds new work too, and it is not a blocker.** Pacing
//!   (`pace.ts` §14) is a decision about how fast a week may be spent, and it
//!   arrives here as one hold per account (`Planned`) rather than as a fifth
//!   kind of blocker: a pace belongs to the account it is stored with, and
//!   putting it into the waterfall would make an account look spent and move
//!   cards to another one, which spends the reserve to keep to the plan.
//!   `verdict` weighs it on the account the work would land on; `held_at` on
//!   the account the card's own wake would run on.
//!
//!   **It has its own release, and it is the wall's tick.** Every other hold
//!   here ends when an account finds room; a pace has no such account, so the
//!   front end asks again every minute and lets go the moment the plan does
//!   (`Skein.#holdSweep`). A bypass ignores it exactly as it ignores a cap, and
//!   Escape drops it like any hold (`#dropHold`). Nothing in flight is stopped:
//!   the gate is asked before a send, a spawn and a wake, never during a turn.
//!
//! **A reading too old to trust admits everything.** The front end re-notes
//! every minute (`Skein.#holdSweep`) and whenever the waterfall moves; a wall
//! whose webview has stopped saying anything is a wall this file knows nothing
//! about, and the failure on that side must be the one that existed before it —
//! a turn tried and refused — never a wake that silently never fires. The one
//! exception is a wall that has *never* spoken since launch (`FIRST_WORD_MS`).
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

/// How close to its ceiling the landing account may be before a new card
/// queues. Lyss's number, 2026-11-02, asked against "on a 5-hour window that
/// leaves roughly 45 minutes of a busy wall's spend for the running cards to
/// finish in". It is a fraction of *her* ceiling where she set a cap, of the
/// server's where she did not — `accounts.ts::spentOf`'s denominator.
///
/// **And it is read against the five-hour window alone** (`admit.ts::nearness`).
/// The number was chosen as "45 minutes of a five-hour window", so applying it
/// to a week at 86% would queue a fan-out for days over a window that still has
/// a day's work in it — and a model-scoped week (the Opus week full) would queue
/// a Haiku lane that never spends it. A week that is genuinely spent is not a
/// nearness question at all: `blockersFor` blocks the account, the ladder moves
/// past it, and the landing account is a different one.
pub const CEILING: f64 = 0.85;

/// Past this a noted reading is not trusted. Five sweeps of the front end's
/// minute, so a wall that is merely busy never trips it.
const STALE_MS: i64 = 5 * 60_000;

/// How long a wall that has not said anything yet is read as **held**, from the
/// moment this process began managing the state.
///
/// The webview notes its first reading a few seconds after `load`; until then
/// the state is empty, and empty used to read as room. That is the right
/// reading for a webview that has *gone* quiet and the wrong one at launch: the
/// waker's first tick finds every wake that came due while the wall was shut,
/// hands each to a card with no process yet, and it goes into the inbox — which
/// `drain_inbox` writes on the next spawn whatever the allowance says. So a
/// wall that has never spoken holds for this long and no longer; a webview that
/// never loads costs only this much, after which silence is room again, exactly
/// as `STALE_MS` argues.
const FIRST_WORD_MS: i64 = 90_000;

/// The least time between two turns the wall hands out on its own when there
/// is more than one to hand out — held prompts released (`admit.ts`'s copy),
/// and wakes and stop notices, which go one a tick on `later::TICK` (asserted
/// to be no shorter) rather than by sleeping on the waker's thread.
///
/// A reset releases everything a spent window was holding in the same tick, and
/// every one of those is a card whose cache went cold during the wait: N full
/// context rewrites at once, the herd the hold existed to avoid, arriving the
/// moment it lifts. `rousing.ts::ROUSE_GAP_MS` is the wall's other pacing, and
/// this is coarser on purpose: what is being spread is not process start-up but
/// requests against one five-hour window. `RELEASE_GAP_MS` in `admit.ts` is the
/// front end's copy for held prompts, and a test holds the two equal.
pub const RELEASE_GAP_MS: u64 = 3_000;

/// What the wall last said, and whether it has said anything at all since this
/// process began (`FIRST_WORD_MS`).
pub struct Allowance(Mutex<Heard>);

impl Default for Allowance {
    fn default() -> Self {
        Allowance(Mutex::new(Heard { born: crate::store::now(), ever: false, noted: None }))
    }
}

struct Heard {
    born: i64,
    /// A note or a forget has arrived. Either is the wall having spoken.
    ever: bool,
    noted: Option<Noted>,
}

/// Where a new card would land and how close that is to its ceiling.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Facet {
    /// The account it would land on, when it is an account. `None` for credits
    /// — an account's own usage credits included, with boost on — and for a
    /// wall with nothing to place it on.
    pub landing: Option<String>,
    /// How close `landing`'s five-hour window is to its ceiling, 0..=1.
    pub spent: Option<f64>,
    /// When that window resets, epoch ms.
    pub resets_at: Option<i64>,
}

/// One account a spawn may be asked onto, and where such a card really lands:
/// the account itself while it is ready, the ladder otherwise (`stickTo`).
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Asked {
    pub account: String,
    #[serde(flatten)]
    pub facet: Facet,
}

/// One account whose plan is holding new work (`pace.ts::PaceHold`), as the
/// front end sent it. `why` is that module's sentence, read by a person rather
/// than a model — `admit.rs` never builds one.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Planned {
    pub account: String,
    pub why: String,
    /// The week's reset, epoch ms: the latest the plan can be holding.
    pub until: Option<i64>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Noted {
    /// No account — and no credits, with boost on — would take a new card.
    pub held: bool,
    /// When the first door opens, epoch ms, where a blocker named one.
    pub until: Option<i64>,
    /// The same for a card bypassing your caps: every account is past the
    /// *server's* ceiling. A card with the bypass on is held only by this.
    pub held_bypass: bool,
    pub until_bypass: Option<i64>,
    /// A card with nothing to stick to.
    pub plain: Facet,
    /// A card asked onto each registered account.
    pub asked: Vec<Asked>,
    /// The accounts whose own plan is holding new work, and until when.
    pub plans: Vec<Planned>,
    /// When this was noted, on this clock.
    pub at: i64,
}

fn clean_facet(f: Facet) -> Facet {
    Facet {
        landing: f
            .landing
            .map(|l| crate::clip::preview(&crate::clean::scrub(l.trim()), 80))
            .filter(|l| !l.is_empty()),
        spent: f.spent.filter(|s| s.is_finite() && *s >= 0.0),
        resets_at: f.resets_at,
    }
}

/// The front end's word, written as it changes. A mutex and nothing else, so it
/// is safe on the main thread — the rule `off_main` enforces is about waiting,
/// and nothing here waits.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn note_allowance(
    state: State<'_, Allowance>,
    held: bool,
    until: Option<i64>,
    held_bypass: Option<bool>,
    until_bypass: Option<i64>,
    landing: Option<String>,
    spent: Option<f64>,
    resets_at: Option<i64>,
    asked: Option<Vec<Asked>>,
    plans: Option<Vec<Planned>>,
) {
    let noted = noted_from(
        held,
        until,
        held_bypass,
        until_bypass,
        Facet { landing, spent, resets_at },
        asked,
        plans,
    );
    if let Ok(mut h) = state.0.lock() {
        h.ever = true;
        h.noted = Some(noted);
    }
}

/// The command's body, apart so it can be asserted without a Tauri state.
fn noted_from(
    held: bool,
    until: Option<i64>,
    held_bypass: Option<bool>,
    until_bypass: Option<i64>,
    plain: Facet,
    asked: Option<Vec<Asked>>,
    plans: Option<Vec<Planned>>,
) -> Noted {
    Noted {
        held,
        until,
        /* Absent reads as "the same as without the bypass", which is the reading
           that holds more rather than less — never a bypassed card woken into a
           spent wall because a key went missing on the way. */
        held_bypass: held_bypass.unwrap_or(held),
        until_bypass: if held_bypass.is_some() { until_bypass } else { until },
        plain: clean_facet(plain),
        asked: asked
            .unwrap_or_default()
            .into_iter()
            .take(32)
            .map(|a| Asked { account: a.account.trim().to_string(), facet: clean_facet(a.facet) })
            .filter(|a| !a.account.is_empty())
            .collect(),
        /* The sentence is one the front end made and this file only repeats on a
           face, so it is scrubbed and cut rather than trusted — the `clip` rule
           for a text nobody here wrote. A hold with nothing to say is dropped:
           the account being held is the fact, and a blank sentence would put
           one on the wall with no reason under it. */
        plans: plans
            .unwrap_or_default()
            .into_iter()
            .take(32)
            .map(|p| Planned {
                account: p.account.trim().to_string(),
                why: crate::clip::preview(&crate::clean::scrub(p.why.trim()), 240),
                until: p.until,
            })
            .filter(|p| !p.account.is_empty() && !p.why.is_empty())
            .collect(),
        at: crate::store::now(),
    }
}

/// The plan holding this account, if one is.
fn plan_for<'a>(n: &'a Noted, account: &str) -> Option<&'a Planned> {
    n.plans.iter().find(|p| p.account == account)
}

/// The wall has no accounts to manage, or has stopped managing them.
#[tauri::command]
pub fn forget_allowance(state: State<'_, Allowance>) {
    if let Ok(mut h) = state.0.lock() {
        h.ever = true;
        h.noted = None;
    }
}

fn heard(app: &AppHandle) -> Option<(bool, i64, Option<Noted>)> {
    let state = app.try_state::<Allowance>()?;
    let h = state.0.lock().ok()?;
    Some((h.ever, h.born, h.noted.clone()))
}

/// What a new card is told about where it stands.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Queued {
    /// The face's line, lowercase and quiet: what it is waiting on.
    pub why: String,
    /// When it starts at the latest, if anything named a time.
    pub until: Option<i64>,
    /// `pace` where the wait is a plan rather than a spent window. The front
    /// end draws both from `why`, and the release pass uses this to know it
    /// owes the allowance endpoint no reading (`Skein.#releasePass`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
}

/// Admit a new card, or say why it waits. Pure, so the rule is asserted.
///
/// `given` is where the card will really land, when the front end can say so —
/// at release it hands over its own `#decide` for the card, bypass and credits
/// included, which no summary made for a card without them can stand in for.
/// Otherwise `prefer` is the account the card was asked onto, if any — the one
/// its spawn named — and where the wall said how such a card lands, that facet
/// is read; failing both, the plain one.
/// `working_on` counts the cards mid-turn **on a given account**, less the
/// card's own ancestry (`queued`): only work spending the same window can finish
/// first and give the room back, and a card waiting on the one being admitted is
/// not work that will finish before it.
pub fn verdict(
    noted: Option<&Noted>,
    given: Option<&Facet>,
    prefer: Option<&str>,
    bypass: bool,
    working_on: impl Fn(&str) -> usize,
    now: i64,
) -> Option<Queued> {
    let n = noted.filter(|n| now.saturating_sub(n.at) <= STALE_MS)?;
    let (held, until) = if bypass { (n.held_bypass, n.until_bypass) } else { (n.held, n.until) };
    if held {
        return Some(Queued {
            why: "queued — every account is spent, so it starts when one has room".into(),
            until,
            reason: None,
        });
    }
    let facet = given
        .or_else(|| prefer.and_then(|p| n.asked.iter().find(|a| a.account == p)).map(|a| &a.facet))
        .unwrap_or(&n.plain);
    let landing = facet.landing.as_deref()?;
    /* The plan, before the window's nearness: a paced account is not full, and
       "no account has room" would be the wrong sentence for a wall that has
       plenty of room and has decided not to spend it this fast. A bypassed card
       spends past the plan as it spends past your caps. */
    if !bypass {
        if let Some(p) = plan_for(n, landing) {
            return Some(Queued {
                why: format!("queued — {}", p.why),
                until: p.until.filter(|t| *t > now),
                reason: Some("pace"),
            });
        }
    }
    let spent = facet.spent?;
    if spent < CEILING {
        return None;
    }
    let working = working_on(landing);
    if working == 0 {
        return None;
    }
    let pct = (spent * 100.0).floor().min(999.0) as u32;
    let others = if working == 1 {
        "the card already working on it finishes".to_string()
    } else {
        format!("the {working} cards already working on it finish")
    };
    Some(Queued {
        why: format!("queued — {landing} is {pct}% into its five hours, so {others} first"),
        until: facet.resets_at.filter(|t| *t > now),
        reason: None,
    })
}

/// A card and every card above it — its spawner, its spawner's spawner. None of
/// them is work the card should wait behind: each is very likely *waiting on
/// it*, in a Monitor loop, a parked question or a poll, and a parent holding a
/// turn open for its child while the child waits for that turn to end is a
/// deadlock that lasts until the window resets. Bounded, since `spawned` is a
/// table anybody's bug could put a cycle in.
fn lineage_up(conn: &rusqlite::Connection, card: &str) -> Vec<String> {
    let mut out = vec![card.to_string()];
    let mut at = card.to_string();
    for _ in 0..32 {
        let Some(p) = crate::store::spawner_of(conn, &at) else { break };
        if out.contains(&p) {
            break;
        }
        out.push(p.clone());
        at = p;
    }
    out
}

/// The same, read off the live wall. `card` is the card being admitted — at a
/// spawn its `spawned` row is already written, so its ancestry is the caller and
/// everything above it; at release it is the queued card.
///
/// Takes the supervisor's lock, which `deliver_blocks` holds across a stdin
/// write — so a Tauri command that reaches this must be off the main thread
/// (`admit_now`), `CLAUDE.md`'s back-door freeze. That lock is let go before
/// the store's is taken.
pub fn queued(app: &AppHandle, card: Option<&str>, prefer: Option<&str>) -> Option<Queued> {
    queued_on(app, card, None, prefer)
}

/// `queued`, with the landing handed over rather than looked up (`verdict`'s
/// `given`).
fn queued_on(app: &AppHandle, card: Option<&str>, given: Option<Facet>, prefer: Option<&str>) -> Option<Queued> {
    /* A provider card is never queued. The `held` this file weighs is the
       wall's Claude windows — every account spent for the next hour — and a
       card spending a per-token balance is not waiting behind any of them. Left
       in, a DeepSeek card would refuse to start on a wall whose Claude accounts
       are all spent, which is the one moment somebody might deliberately reach
       for the other provider. `prefer` is read as well as the row because a
       spawn can ask before its row exists. See `provider.rs`. */
    if prefer.is_some_and(|p| crate::provider::is_provider(Some(p))) || provider_card(app, card) {
        return None;
    }
    let (_, _, n) = heard(app)?;
    let n = n?;
    let mid = app
        .try_state::<crate::supervisor::Supervisor>()
        .map(|s| s.mid_turn())
        .unwrap_or_default();
    let (labels, bypass) = app
        .try_state::<crate::store::Store>()
        .and_then(|store| {
            let conn = store.0.lock().ok()?;
            let skip = card.map(|c| lineage_up(&conn, c)).unwrap_or_default();
            let labels: Vec<String> = mid
                .iter()
                .filter(|id| !skip.contains(id))
                .filter_map(|id| crate::store::account_of(&conn, id))
                .collect();
            Some((labels, card.is_some_and(|c| bypass_of(&conn, c))))
        })
        .unwrap_or_default();
    verdict(
        Some(&n),
        given.map(clean_facet).as_ref(),
        prefer,
        bypass,
        |label| labels.iter().filter(|l| l.as_str() == label).count(),
        crate::store::now(),
    )
}

/// Whether this card's row says it spends a provider's balance rather than a
/// Claude one. `false` for a card with no row yet, which is a spawn that has
/// not been written and therefore cannot be a provider card in this build.
fn provider_card(app: &AppHandle, card: Option<&str>) -> bool {
    let Some(card) = card else { return false };
    app.try_state::<crate::store::Store>()
        .and_then(|store| {
            let conn = store.0.lock().ok()?;
            crate::store::account_of(&conn, card)
        })
        .is_some_and(|label| crate::provider::is_provider(Some(&label)))
}

/// Whether a card is set to ignore your caps (`conversation.bypass_caps`).
pub fn bypass_of(conn: &rusqlite::Connection, id: &str) -> bool {
    conn.query_row("SELECT bypass_caps FROM conversation WHERE id = ?1", [id], |r| r.get::<_, i64>(0))
        .map(|b| b != 0)
        .unwrap_or(false)
}

/// Whether a card queued at spawn may start now. The front end asks this from
/// `releaseHeld`, having noted a fresh reading first, rather than deciding it
/// again — one rule, in one place. Weighed where the release will put the card
/// (`facet`, the front end's own decision for it), else on the account it
/// opened on, and with its ancestry left out of the count, exactly as at the
/// spawn.
#[tauri::command(async)]
pub async fn admit_now(app: AppHandle, id: String, facet: Option<Facet>) -> Result<Option<Queued>, String> {
    crate::off_main(move || {
        let prefer = app
            .try_state::<crate::store::Store>()
            .and_then(|s| s.0.lock().ok().and_then(|c| crate::store::account_of(&c, &id)));
        queued_on(&app, Some(&id), facet, prefer.as_deref())
    })
    .await
}

/// Every account is spent, so a prompt Rust writes on its own initiative would
/// be a turn that never reaches a model. `Some(until)` while that is true, with
/// the first door's time where one is known. Pure over what was heard.
///
/// `bypass` is the card's own: a card ignoring your caps is held only by the
/// server's ceiling, so its wake goes as soon as any account has room by the
/// server's reckoning, whatever your caps say for every other card.
pub fn held_at(
    ever: bool,
    born: i64,
    noted: Option<&Noted>,
    bypass: bool,
    /* The account the card's own wake would run on, where it has one. */
    prefer: Option<&str>,
    now: i64,
) -> Option<Option<i64>> {
    if !ever {
        return (now.saturating_sub(born) < FIRST_WORD_MS).then_some(None);
    }
    let n = noted.filter(|n| now.saturating_sub(n.at) <= STALE_MS)?;
    if bypass {
        return n.held_bypass.then_some(n.until_bypass);
    }
    if n.held {
        return Some(n.until);
    }
    /* A plan is applied to the account it belongs to, and a card on none is
       weighed where the wall would put a new card — the same fallback
       `verdict` makes. No plan for that label is no hold: a pace never
       invents one for an account that has none. */
    let label = prefer.or(n.plain.landing.as_deref())?;
    plan_for(n, label).map(|p| p.until.filter(|t| *t > now))
}

/// Whether the wall would hold a turn written into `card` now — its bypass
/// asked of the store. For `serve_due` and `sweep`, which hold per card.
pub fn held_for(app: &AppHandle, card: &str) -> Option<Option<i64>> {
    /* The same exemption as `queued_on`: a provider card's wake is not waiting
       on a Claude window it does not spend. Without this a card on DeepSeek
       would sleep until the next five-hour reset along with everything else. */
    if provider_card(app, Some(card)) {
        return None;
    }
    let (ever, born, n) = heard(app)?;
    let (bypass, prefer) = app
        .try_state::<crate::store::Store>()
        .and_then(|s| {
            let conn = s.0.lock().ok()?;
            Some((bypass_of(&conn, card), crate::store::account_of(&conn, card)))
        })
        .unwrap_or((false, None));
    held_at(ever, born, n.as_ref(), bypass, prefer.as_deref(), crate::store::now())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facet(spent: f64) -> Facet {
        Facet { landing: Some("tx-team".into()), spent: Some(spent), resets_at: Some(10_000) }
    }

    fn n(spent: f64) -> Noted {
        Noted { plain: facet(spent), at: 1_000, ..Default::default() }
    }

    /// `working` cards mid-turn on `tx-team`, nobody anywhere else.
    fn on_tx(working: usize) -> impl Fn(&str) -> usize {
        move |l| if l == "tx-team" { working } else { 0 }
    }

    #[test]
    fn room_on_the_landing_account_admits() {
        assert_eq!(verdict(Some(&n(0.84)), None, None, false, on_tx(5), 2_000), None);
    }

    #[test]
    fn nearly_spent_with_work_running_queues_until_the_reset() {
        let q = verdict(Some(&n(0.88)), None, None, false, on_tx(3), 2_000).expect("queued");
        assert!(q.why.contains("tx-team is 88% into its five hours"), "{}", q.why);
        assert!(q.why.contains("3 cards already working on it"), "{}", q.why);
        assert_eq!(q.until, Some(10_000));
    }

    /// Nobody to finish first: starting one card is not a fan-out draining the
    /// window, and holding it would only wait for a reset nothing is spending
    /// towards.
    #[test]
    fn nearly_spent_with_nothing_working_admits() {
        assert_eq!(verdict(Some(&n(0.97)), None, None, false, on_tx(0), 2_000), None);
    }

    /// Cards working on *another* account spend another window. Waiting behind
    /// them gives this one nothing back.
    #[test]
    fn work_on_other_accounts_is_not_waited_behind() {
        let elsewhere = |l: &str| if l == "personal" { 4 } else { 0 };
        assert_eq!(verdict(Some(&n(0.95)), None, None, false, elsewhere, 2_000), None);
    }

    /// A spawn asked onto an account lands where `stickTo` puts it, and that is
    /// the account weighed — not wherever a card with no preference would go.
    #[test]
    fn a_card_asked_onto_an_account_is_weighed_there() {
        let mut noted = n(0.2);
        noted.asked = vec![Asked {
            account: "tx-team".into(),
            facet: Facet { landing: Some("tx-team".into()), spent: Some(0.9), resets_at: Some(9_000) },
        }];
        noted.plain.landing = Some("personal".into());
        let busy = |l: &str| if l == "tx-team" { 2 } else { 1 };
        assert!(verdict(Some(&noted), None, Some("tx-team"), false, busy, 2_000).is_some());
        assert_eq!(verdict(Some(&noted), None, None, false, busy, 2_000), None);
        /* An account the wall said nothing about falls back to the plain one. */
        assert_eq!(verdict(Some(&noted), None, Some("unknown"), false, busy, 2_000), None);
        /* And the landing the front end hands over at release outranks both:
           its own decision for the card, here credits, admits. */
        let credits = Facet::default();
        assert_eq!(verdict(Some(&noted), Some(&credits), Some("tx-team"), false, busy, 2_000), None);
    }

    #[test]
    fn a_held_wall_queues_whatever_the_counts() {
        let held = Noted { held: true, until: Some(9_000), held_bypass: true, until_bypass: Some(9_000), at: 1_000, ..Default::default() };
        let q = verdict(Some(&held), None, None, false, on_tx(0), 2_000).expect("queued");
        assert!(q.why.contains("every account is spent"), "{}", q.why);
        assert_eq!(q.until, Some(9_000));
        assert_eq!(held_at(true, 0, Some(&held), false, None, 2_000), Some(Some(9_000)));
    }

    /// Held by your caps and not by the server's: a card bypassing the caps is
    /// not held, and every other card is.
    #[test]
    fn a_bypassed_card_is_held_only_by_the_server() {
        let caps = Noted { held: true, until: Some(9_000), held_bypass: false, at: 1_000, ..Default::default() };
        assert_eq!(held_at(true, 0, Some(&caps), false, None, 2_000), Some(Some(9_000)));
        assert_eq!(held_at(true, 0, Some(&caps), true, None, 2_000), None);
        assert_eq!(verdict(Some(&caps), None, None, true, on_tx(9), 2_000), None);
    }

    /// An older front end that sends no bypass reading holds bypassed cards
    /// with everyone else, rather than waking them into a spent wall.
    #[test]
    fn a_missing_bypass_reading_holds_like_the_plain_one() {
        let noted = noted_from(true, Some(5), None, None, Facet::default(), None, None);
        assert!(noted.held_bypass);
        assert_eq!(noted.until_bypass, Some(5));
    }

    /// The failure on a silent webview must be the one that existed before:
    /// tried and refused, never a wake or a card that waits on nothing.
    #[test]
    fn a_stale_or_absent_reading_admits_and_holds_nothing() {
        assert_eq!(verdict(None, None, None, false, on_tx(9), 2_000), None);
        let held = Noted { held: true, held_bypass: true, at: 0, ..Default::default() };
        assert_eq!(verdict(Some(&held), None, None, false, on_tx(9), STALE_MS + 1), None);
        assert_eq!(held_at(true, 0, Some(&held), false, None, STALE_MS + 1), None);
        assert_eq!(held_at(true, 0, None, false, None, 0), None);
    }

    /// At launch, before the webview has said anything, every wake that came
    /// due while the wall was shut would go into an inbox and out again on the
    /// next spawn, past any hold. So a wall that has never spoken holds — and
    /// only for `FIRST_WORD_MS`, after which silence is room as ever.
    #[test]
    fn a_wall_that_has_not_spoken_yet_holds_briefly() {
        assert_eq!(held_at(false, 1_000, None, false, None, 1_000 + FIRST_WORD_MS - 1), Some(None));
        assert_eq!(held_at(false, 1_000, None, true, None, 1_000 + 5), Some(None));
        assert_eq!(held_at(false, 1_000, None, false, None, 1_000 + FIRST_WORD_MS), None);
        /* A forget is the wall speaking: no accounts, nothing to hold on. */
        assert_eq!(held_at(true, 1_000, None, false, None, 1_005), None);
    }

    /// Credits, or a wall with nothing measured: no account to be near a
    /// ceiling of, so nothing to queue behind.
    #[test]
    fn no_landing_account_admits() {
        let credits = Noted { at: 1_000, ..Default::default() };
        assert_eq!(verdict(Some(&credits), None, None, false, |_| 4, 2_000), None);
    }

    /// A reset already past is not a time to wait for.
    #[test]
    fn a_past_reset_is_not_offered() {
        let q = verdict(Some(&n(0.9)), None, None, false, on_tx(1), 20_000).expect("queued");
        assert_eq!(q.until, None);
        assert!(q.why.contains("the card already working on it finishes"), "{}", q.why);
    }

    /// A plan holding this account (`pace.ts::PaceHold`), with the wall's
    /// landing on `tx-team` and nothing they need to finish first.
    fn paced_noted(account: &str, until: i64) -> Noted {
        Noted {
            plain: facet(0.2),
            plans: vec![Planned {
                account: account.into(),
                why: "paced: the week is at 71% against a plan of 55% by now".into(),
                until: Some(until),
            }],
            at: 1_000,
            ..Default::default()
        }
    }

    /// A pace is a reason to hold that is not a window being full, and its
    /// sentence says so: "no account has room" would be false about a wall
    /// with room that has decided not to spend it this fast.
    #[test]
    fn a_pace_holds_a_spawn_on_the_account_it_belongs_to() {
        let noted = paced_noted("tx-team", 10_000);
        let q = verdict(Some(&noted), None, None, false, on_tx(0), 2_000).expect("queued");
        assert!(q.why.starts_with("queued — paced:"), "{}", q.why);
        assert_eq!(q.until, Some(10_000));
        assert_eq!(q.reason, Some("pace"));
    }

    /// A plan belongs to its account. A card asked onto one without a plan is
    /// not held, and a wake is weighed on the account it would spend.
    #[test]
    fn a_pace_belongs_to_its_account_and_not_to_the_wall() {
        let mut noted = paced_noted("tx-team", 10_000);
        noted.asked = vec![Asked {
            account: "personal".into(),
            facet: Facet { landing: Some("personal".into()), spent: Some(0.2), resets_at: Some(5_000) },
        }];
        assert_eq!(verdict(Some(&noted), None, Some("personal"), false, on_tx(0), 2_000), None);
        assert_eq!(held_at(true, 0, Some(&noted), false, Some("personal"), 2_000), None);
        assert_eq!(
            held_at(true, 0, Some(&noted), false, Some("tx-team"), 2_000),
            Some(Some(10_000))
        );
        /* A card with no account is weighed where the wall would put a new one. */
        assert_eq!(held_at(true, 0, Some(&noted), false, None, 2_000), Some(Some(10_000)));
    }

    /// A pacing system a bypass cannot overrule on the afternoon that matters
    /// is one nobody leaves on.
    #[test]
    fn a_bypassed_card_spends_past_the_plan() {
        let noted = paced_noted("tx-team", 10_000);
        assert_eq!(verdict(Some(&noted), None, None, true, on_tx(0), 2_000), None);
        assert_eq!(held_at(true, 0, Some(&noted), true, Some("tx-team"), 2_000), None);
    }

    /// A spent window is the immediate blocker; a plan is the longer wait, and
    /// saying "paced" about a wall with nothing left would name the wrong one.
    #[test]
    fn a_spent_wall_speaks_before_a_plan() {
        let mut noted = paced_noted("tx-team", 10_000);
        (noted.held, noted.until) = (true, Some(9_000));
        let q = verdict(Some(&noted), None, None, false, on_tx(0), 2_000).expect("queued");
        assert!(q.why.contains("every account is spent"), "{}", q.why);
        assert_eq!(q.reason, None);
    }

    /// A reset already past is not a time to offer, and the hold is still a
    /// hold: the next reading replaces it.
    #[test]
    fn a_pace_whose_week_has_rolled_offers_no_time() {
        let noted = paced_noted("tx-team", 1_500);
        let q = verdict(Some(&noted), None, None, false, on_tx(0), 2_000).expect("queued");
        assert_eq!(q.until, None);
        assert_eq!(held_at(true, 0, Some(&noted), false, Some("tx-team"), 2_000), Some(None));
    }

    /// The sentence comes from the front end, so it is scrubbed and a plan with
    /// nothing to say is dropped rather than held on a blank face.
    #[test]
    fn a_plan_with_nothing_to_say_is_dropped_and_its_sentence_scrubbed() {
        let plans = vec![
            Planned { account: " a ".into(), why: "paced: a\u{0}b".into(), until: Some(5) },
            Planned { account: "b".into(), why: "   ".into(), until: Some(5) },
            Planned { account: " ".into(), why: "paced".into(), until: Some(5) },
        ];
        let noted = noted_from(false, None, None, None, Facet::default(), None, Some(plans));
        assert_eq!(noted.plans.len(), 1);
        assert_eq!(noted.plans[0].account, "a");
        assert!(!noted.plans[0].why.contains('\u{0}'), "{:?}", noted.plans[0].why);
    }

    /// The parent waiting on its queued child, and the grandparent waiting on
    /// the parent, are not work the child waits behind.
    #[test]
    fn a_card_does_not_wait_behind_its_own_ancestry() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE spawned (child_id TEXT PRIMARY KEY, parent_id TEXT NOT NULL);
             INSERT INTO spawned VALUES ('child', 'parent'), ('parent', 'grand'), ('loop-a', 'loop-b'), ('loop-b', 'loop-a');",
        )
        .unwrap();
        assert_eq!(lineage_up(&conn, "child"), vec!["child", "parent", "grand"]);
        assert_eq!(lineage_up(&conn, "orphan"), vec!["orphan"]);
        assert_eq!(lineage_up(&conn, "loop-a"), vec!["loop-a", "loop-b"]);
    }
}
