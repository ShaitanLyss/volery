//! Credits: a card that runs on an Anthropic API key instead of a subscription.
//!
//! The money is the monthly API credit Max and Team plans now include (up to
//! $500 pooled on Team), claimed by linking a Claude Console organisation to the
//! plan. Anthropic says those credits do not cover Claude Code — and then makes
//! the exception this module rests on: **`claude -p` run with an API key from the
//! linked organisation is billed as Agent SDK usage, and the credits cover it.**
//! Every card on this wall is a `claude --print` child. Read out of claude
//! 2.1.304 on 2026-10-24: the CLI sets `CLAUDE_CODE_ENTRYPOINT=sdk-cli` for a
//! print-mode session and reports `sdk-cli` as `claude_code_sdk`, the class the
//! credits pay for. `.claude/rules/accounts.md`, *Credits and boost mode*, has the
//! whole of it.
//!
//! A card on credits carries [`LABEL`] where an account label goes. It is not an
//! account: `accounts::is_label` refuses `@`, so no registered account can ever be
//! called this, and every path that would name a credential store for a label
//! asks [`is_credits`] first. The front end decides *when* a card goes onto
//! credits (`credits.ts`, the routing, behind boost mode); this file is only what
//! putting one there means for the child.

use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use tauri::{AppHandle, Manager, State};

/// What `conversation.account_label` holds for a card spending credits. Kept in
/// step with `credits.ts::CREDITS` by `test/credits.test.ts`, which reads this
/// file.
pub const LABEL: &str = "@credits";

/// The vault entry the key lives in, through `creds.rs`'s table.
pub const SERVICE: &str = "anthropic";

pub fn is_credits(label: Option<&str>) -> bool {
    label == Some(LABEL)
}

/// Put a child on the API key, or refuse to spawn it.
///
/// **The key outranks the account's sign-in**, which is the whole mechanism:
/// probed against claude 2.1.304, `ANTHROPIC_API_KEY` beside a signed-in store
/// reports `authMethod: "api_key"`, and a print-mode turn under a dummy key
/// answered `401 Invalid API key` rather than falling back to the subscription.
/// `apiKeyHelper` was the other way in and is not usable here: under `--print`
/// with `--settings` it hung for ninety seconds and produced nothing.
///
/// The store is still pointed at an **empty** directory. With the key present it
/// changes nothing; it is there for a CLI that one day stops honouring the
/// variable, which would otherwise fall through to the global sign-in and
/// quietly spend a subscription while the card says credits. An empty store
/// answers `authMethod: "none"`, so that failure is loud — the same bargain
/// `spawn_now` strikes for an account that is not signed in.
///
/// `CLAUDE_CODE_ENTRYPOINT` is taken off so the CLI names the session itself. A
/// wall launched from inside another card would otherwise hand its children the
/// parent's entrypoint, and the entrypoint is what decides which bucket the
/// spend lands in.
pub fn apply(app: &AppHandle, cmd: &mut Command) -> Result<(), String> {
    let key = crate::creds::token(SERVICE)
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
        .ok_or_else(|| {
            "no Anthropic API key is stored, so this card cannot run on credits — add one in the \
             keyring (space then o)"
                .to_string()
        })?;
    cmd.env("ANTHROPIC_API_KEY", key);
    cmd.env("CLAUDE_SECURESTORAGE_CONFIG_DIR", empty_store(app)?);
    cmd.env_remove("CLAUDE_CODE_OAUTH_TOKEN");
    cmd.env_remove("ANTHROPIC_AUTH_TOKEN");
    cmd.env_remove("CLAUDE_CODE_ENTRYPOINT");
    Ok(())
}

/// Every child that is **not** on credits loses any key it would inherit.
///
/// Volery's own environment carries none — but a lab wall started from inside a
/// card on credits does, and without this every card on that lab would spend
/// the credits while drawing the lab's accounts. The key outranks a signed-in
/// store (above), so inheriting it is not harmless.
pub fn withhold(cmd: &mut Command) {
    cmd.env_remove("ANTHROPIC_API_KEY");
}

fn empty_store(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("no local data dir: {e}"))?
        .join("credits-store");
    std::fs::create_dir_all(&dir).map_err(|e| format!("credits store: {e}"))?;
    Ok(dir)
}

/* ── what the wall last said about boost ─────────────────────────────────── */

/// Boost mode as the wall last reported it. The switch is the front end's — a
/// per-machine setting, like the chime — and it is written here as it changes
/// so the allowance tool can say it without asking the webview. `quit::note_busy`
/// is the same shape for the same reason.
#[derive(Default)]
pub struct Boost(Mutex<Noted>);

#[derive(Default, Clone, Copy)]
pub struct Noted {
    pub on: bool,
    /// The month's ceiling on credits, in dollars — yours, not the Console's.
    pub budget: Option<f64>,
    /// Where this month began, in epoch ms, on the front end's calendar.
    pub since: Option<i64>,
}

#[tauri::command]
pub fn note_boost(boost: State<'_, Boost>, on: bool, budget: Option<f64>, since: Option<i64>) {
    if let Ok(mut n) = boost.0.lock() {
        *n = Noted { on, budget: budget.filter(|b| b.is_finite() && *b >= 0.0), since };
    }
}

fn noted(app: &AppHandle) -> Noted {
    app.try_state::<Boost>()
        .and_then(|b| b.0.lock().ok().map(|n| *n))
        .unwrap_or_default()
}

/* ── the ledger ─────────────────────────────────────────────────────────── */

/// What this wall's cards have spent on credits since `since`, in dollars.
///
/// Off the `turn` table, whose `account_label` says which funding each turn ran
/// on (`migrate_v59`). It is the wall's own figure, not the balance: the
/// Console's balance is read with an admin key this app does not hold, and the
/// organisation's other keys spend the same credits. So the face says *spent by
/// this wall*, never *left*.
pub fn spent_since(conn: &rusqlite::Connection, since: i64) -> f64 {
    conn.query_row(
        "SELECT COALESCE(SUM(usd), 0) FROM turn WHERE account_label = ?1 AND ended_at >= ?2",
        rusqlite::params![LABEL, since],
        |r| r.get::<_, f64>(0),
    )
    .unwrap_or(0.0)
}

#[tauri::command]
pub fn credits_spent(store: State<'_, crate::store::Store>, since: i64) -> Result<f64, String> {
    let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
    Ok(spent_since(&conn, since))
}

/* ── what a card on credits is told about the bill ──────────────────────── */

/// The `allowance` tool's answer for a card on credits.
///
/// There is no window to report — an API key has none — and the honest
/// replacement is the bill: what the wall has spent on credits this month
/// against the ceiling you set, and that every token from here is money. The
/// advice is milder than the allowance ladder's last rungs on purpose: boost is
/// a decision the user made to keep work moving, and an agent told to do the
/// smallest thing possible would be overruling it.
pub fn allowance_answer(app: &AppHandle, day: &str, others: &[String]) -> String {
    let n = noted(app);
    let spent = n
        .since
        .and_then(|since| {
            app.try_state::<crate::store::Store>()
                .and_then(|s| s.0.lock().ok().map(|c| spent_since(&c, since)))
        })
        .unwrap_or(0.0);
    say_allowance(n, spent, day, others)
}

fn say_allowance(n: Noted, spent: f64, day: &str, others: &[String]) -> String {
    let mut out = String::from(
        "Account: credits. This card runs on an Anthropic API key, billed per token at API \
         prices against the organisation's monthly credits rather than against a \
         subscription. There are no windows to run out of, and the remaining balance is the \
         Console's, which this wall cannot read.\n",
    );
    match n.budget {
        Some(b) => out.push_str(&format!(
            "- spent on credits by this wall this month: ${spent:.2} of the ${b:.0} you allowed it\n"
        )),
        None => out.push_str(&format!("- spent on credits by this wall this month: ${spent:.2}\n")),
    }
    out.push_str(if n.on {
        "- boost mode is on: the user chose to spend credits to keep work moving when an \
         account runs out.\n"
    } else {
        "- boost mode is off: the wall will move this card back to a subscription at its next \
         message.\n"
    });
    out.push_str(day);
    out.push('\n');
    if !others.is_empty() {
        out.push_str(&format!(
            "The wall moves this card back to its own subscription when that has room again ({} \
             usable on this wall: {}).\n",
            others.len(),
            others.join(", ")
        ));
    }
    out.push_str(
        "\nEvery token here is money. Do the work you were asked to do, without fanning out \
         further than it needs.",
    );
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_account_can_be_called_credits() {
        assert!(!crate::accounts::is_label(LABEL));
        assert!(is_credits(Some(LABEL)));
        assert!(!is_credits(Some("credits")));
        assert!(!is_credits(None));
    }

    #[test]
    fn the_answer_names_the_bill_and_the_budget() {
        let on = Noted { on: true, budget: Some(500.0), since: Some(0) };
        let said = say_allowance(on, 88.123, "This wall has spent $41.00 in the last 24 hours.", &["alizee".into()]);
        assert!(said.starts_with("Account: credits."));
        assert!(said.contains("$88.12 of the $500 you allowed it"));
        assert!(said.contains("boost mode is on"));
        assert!(said.contains("alizee"));
        let off = Noted { on: false, budget: None, since: None };
        let said = say_allowance(off, 0.0, "", &[]);
        assert!(said.contains("boost mode is off"));
        assert!(!said.contains("usable on this wall"));
    }

    #[test]
    fn the_ledger_counts_credits_turns_and_nothing_else() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE turn (usd REAL, ended_at INTEGER, account_label TEXT);
             INSERT INTO turn VALUES (1.5, 100, '@credits');
             INSERT INTO turn VALUES (2.0, 200, '@credits');
             INSERT INTO turn VALUES (9.0, 200, 'tx-team');
             INSERT INTO turn VALUES (4.0, 200, NULL);
             INSERT INTO turn VALUES (7.0, 50, '@credits');",
        )
        .unwrap();
        assert_eq!(spent_since(&conn, 100), 3.5);
        assert_eq!(spent_since(&conn, 0), 10.5);
        assert_eq!(spent_since(&conn, 1000), 0.0);
    }
}
