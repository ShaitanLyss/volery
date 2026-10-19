//! More than one subscription, in an order.
//!
//! The facts half. `accounts.ts` decides *which* account the next turn goes to
//! and what to say about it; this holds the registry, and points one child
//! process at one account's credentials. The same split `limits.rs` draws
//! against `limits.ts`, and `.claude/rules/accounts.md` is the whole of the
//! reasoning.
//!
//! ### An account is a credential store, not a token
//!
//! This was `~/.claude/tokens/<label>.tok` — a long-lived token from `claude
//! setup-token`, DPAPI-wrapped, put on the child as `CLAUDE_CODE_OAUTH_TOKEN`.
//! That design worked for spawning cards and for nothing else, because **a
//! `setup-token` token is scoped `user:inference` alone**: `GET
//! /api/oauth/usage` answers it `403`, and so does `/api/oauth/profile`. Probed
//! 2026-08-19 against claude 2.1.235 — the same request with the CLI's own
//! credential answers `200`. It is deliberate and there is no flag for it; the
//! CLI's authorize URL carries `inferenceOnly: true` and its own diagnostics say
//! long-lived tokens "are limited to inference-only for security reasons".
//!
//! An allowance that can never be read took the whole feature down, because
//! `accounts.ts::standingOf` read "cannot be asked" as "unusable" — so every
//! send on a card with an account met "no account available", for an account
//! that would have run perfectly well.
//!
//! So an account is now **its own credential store**, holding a real
//! `claude auth login` credential with the full scope set:
//!
//! ```text
//! ~/.claude/accounts/<label>/.credentials.json
//! ```
//!
//! and a card is put on one by `CLAUDE_SECURESTORAGE_CONFIG_DIR`, which selects
//! the store **and only the store** — `CLAUDE_CONFIG_DIR` is untouched, so
//! transcripts, sessions and therefore the `--resume` the account swap is built
//! on all stay exactly where they were. Probed 2026-08-20, three ways: an empty
//! store dir reports `loggedIn: false, authMethod: "none"` (so there is no
//! quiet fall-through to the global sign-in), a store holding a credential
//! reports `authMethod: "claude.ai"` with the account's email, org and plan, and
//! a real `--print` turn ran under one while writing its transcript to the
//! shared config directory. `claude auth login` honours it too, leaving the
//! global credential byte-identical — which is the step the whole arrangement
//! rests on and the one that needed a browser to check.
//!
//! What this buys, beyond the feature working at all: the allowance endpoint
//! answers per account, so percentages, your caps, the resets and the reports
//! are all real; the credential **refreshes itself**, because the child owns the
//! store and the CLI does what it always does with it; and signing in is the
//! supported interactive flow rather than a long-lived token mint.
//!
//! ### What it costs, said plainly
//!
//! The store is a plain JSON file on Windows, exactly like the global
//! `~/.claude/.credentials.json` it is a sibling of — so this **loses the DPAPI
//! wrapping** the `.tok` design had. That is a real regression in one respect
//! and an improvement in another: on every path a card takes, Skein handles no
//! secret at all. It writes no credential, holds none in memory, and puts none
//! in a child's environment; it names a *directory*, and the CLI does the rest.
//! Spawning, swapping, signing in and reading an allowance are all like that,
//! and `limits.rs` — asking the allowance endpoint about the same file the CLI
//! reads — is the only one of them that opens the thing at all.
//!
//! **A sign-in never leaves its machine.** This file once carried the stores to
//! a second machine in a file, and that was taken out on 2026-10-19 because a
//! refresh token rotates: a copy is two machines spending one chain, and the
//! second to refresh is signed out (see the note where the carry used to be).
//!
//! Nothing here logs or formats a credential, and `Account` — the struct that
//! crosses into the webview on every ordinary read — carries no secret and no
//! path to one.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};

use crate::store::Store;

/* ── the stores on disk ────────────────────────────────────────────────────*/

/// `~/.claude/accounts`. Beside Claude Code's own credential rather than inside
/// Skein's data directory, deliberately: these *are* Claude Code credential
/// stores, written and refreshed by the CLI, and a store Skein happened to own
/// the parent of would still be the CLI's to keep current.
pub fn store_root(app: &AppHandle) -> Result<PathBuf, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("no home dir: {e}"))?;
    Ok(home.join(".claude").join("accounts"))
}

/// The store directory for one account — what goes in
/// `CLAUDE_SECURESTORAGE_CONFIG_DIR`.
pub fn store_dir(app: &AppHandle, label: &str) -> Result<PathBuf, String> {
    if !is_label(label) {
        return Err("that is not a usable account name".into());
    }
    Ok(store_root(app)?.join(label))
}

/// The credential inside one account's store. Public because `limits.rs` reads
/// it to ask the allowance endpoint — the same file, in the same shape, that it
/// already reads for the globally signed-in account.
pub fn credential_path(app: &AppHandle, label: &str) -> Result<PathBuf, String> {
    Ok(store_dir(app, label)?.join(".credentials.json"))
}

/// Letters, digits, dot, dash, underscore — and **never a name made only of
/// dots**.
///
/// A label is a path component joined to a directory, so this is the check that
/// stops one from being `..\..\something` rather than a matter of taste. The
/// dots clause is not decoration and the stakes for it changed with this
/// module: when an account was a *file* (`<label>.tok`), a label of `..` merely
/// named a file called `...tok` and did nothing. Now the label names a
/// **directory** that `sign_out` removes recursively, so `..` would resolve to
/// `~/.claude` and `.` to the store root holding every account. Both pass a
/// bare character-class check, since `.` is a legal character in a real label
/// like `work.2`. So the character set is not sufficient on its own and the
/// component is rejected outright when nothing but dots is left of it.
pub fn is_label(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
        && s.chars().any(|c| c != '.')
}

/// Whether this account has been signed in — i.e. whether its store holds a
/// credential. Says nothing about whether that credential is still *fresh*:
/// an access token expires and the CLI refreshes it on its next turn, so a
/// stale store is a signed-in account whose allowance cannot be read this
/// minute, which is a different thing entirely and `accounts.ts::standingOf`
/// keeps them apart.
pub fn signed_in(app: &AppHandle, label: &str) -> bool {
    credential_path(app, label)
        .map(|p| p.is_file())
        .unwrap_or(false)
}

/// Whether a credential is past reviving: nothing left for the CLI to refresh
/// *with*. Pure, so it is tested against the shapes seen on disk.
///
/// Both stamps have to have passed. The access token lapsing alone is the
/// ordinary idle case and the next turn mends it. The refresh token's own expiry
/// passing alone proves less than it seems — the CLI carries that stamp forward
/// when a refresh response omits one (`accounts.md`, "a field that falls back is
/// not a field that stayed put"), so it can read stale on a credential that still
/// works — which is why it is only believed once the access token has run out as
/// well, when there is nothing else to try. An explicitly *empty* `refreshToken`
/// is the CLI's own "signed out" marking after an `invalid_grant`, and needs no
/// second stamp.
///
/// Missing stamps are never a lapse: a file from an older or newer CLI that
/// carries neither must keep working rather than be written off on absence.
pub fn lapsed_in(cred: &serde_json::Value, now_ms: i64) -> bool {
    let o = cred.get("claudeAiOauth").unwrap_or(cred);
    if o.get("refreshToken").and_then(|v| v.as_str()) == Some("") {
        return true;
    }
    let past = |key: &str| {
        o.get(key)
            .and_then(|v| v.as_i64())
            .is_some_and(|t| t > 0 && t <= now_ms)
    };
    past("expiresAt") && past("refreshTokenExpiresAt")
}

/// [`lapsed_in`] against the store on disk and the clock. `false` when there is
/// nothing to read — "not signed in" is `signed_in`'s answer, not this one's.
pub fn lapsed(app: &AppHandle, label: &str) -> bool {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    read_credential(app, label).is_some_and(|c| lapsed_in(&c, now))
}

/* ── the registry ──────────────────────────────────────────────────────────*/

/// One account as the front end sees it. No credential and no path to one —
/// **this is what crosses into the webview.**
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub label: String,
    /// The tier. Lower runs first, a whole tier is spent before the next is
    /// touched, and accounts sharing one are declared equivalent — `choose` in
    /// `accounts.ts` is the policy and `migrate_v30` is why an upgraded wall
    /// still has one account per tier.
    pub priority: i64,
    pub rank: i64,
    pub enabled: bool,
    /// Window `kind` → percentage ceiling. Free-form because the rate limiter's
    /// window vocabulary moves; see `migrate_v16`.
    pub caps: serde_json::Value,
    /// Whether this account's store holds a credential.
    pub signed_in: bool,
    /// Whether that credential can no longer be refreshed — see [`lapsed_in`].
    /// The idle-reserve failure: a store nothing runs on is `signed_in` by the
    /// file check for weeks after it is dead.
    pub lapsed: bool,
}

#[tauri::command]
pub fn list_accounts(app: AppHandle, store: State<'_, Store>) -> Result<Vec<Account>, String> {
    let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT label, rank, enabled, caps, priority FROM account
             ORDER BY priority, rank, label",
        )
        .map_err(|e| format!("read accounts: {e}"))?;
    let rows = stmt
        .query_map([], |r| {
            let label: String = r.get(0)?;
            let caps: String = r.get(3)?;
            Ok((
                label,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                caps,
                r.get::<_, i64>(4)?,
            ))
        })
        .map_err(|e| format!("read accounts: {e}"))?;

    let mut out = Vec::new();
    for row in rows {
        let (label, rank, enabled, caps, priority) =
            row.map_err(|e| format!("read accounts: {e}"))?;
        let has = signed_in(&app, &label);
        out.push(Account {
            caps: serde_json::from_str(&caps).unwrap_or_else(|_| serde_json::json!({})),
            signed_in: has,
            lapsed: has && lapsed(&app, &label),
            label,
            priority,
            rank,
            enabled: enabled != 0,
        });
    }
    Ok(out)
}

/// The labels that could actually take work: registered, switched on, and with
/// a credential in their store. Rank order, like everything else here.
///
/// The Rust mirror of `accounts.ts::usable`, and it exists for one caller.
/// `limits.rs` answers an agent's question about **one** account's allowance —
/// its own card's, and the note on `token` is the long argument for why that
/// scoping is right — and it has to be able to say whether that account is the
/// whole wall. Reported as though it were, a spent account reads as a spent
/// subscription: a card did exactly that, told the user to hold four and a half
/// hours of work, and declined to start anything, with two untouched
/// subscriptions sitting behind it in the order (sink `0b4ba579`).
///
/// `signed_in` is a file check and this runs under the store's lock, which is
/// the bargain `list_accounts` above already strikes: a handful of `is_file()`
/// calls against the local disk, against a second acquisition of a mutex the
/// whole wall shares. Degrades to empty rather than erroring — a caller that
/// cannot count the wall's accounts should say nothing about them, not refuse to
/// answer the question it was actually asked.
pub fn usable_labels(app: &AppHandle, conn: &rusqlite::Connection) -> Vec<String> {
    registry(app, conn)
        .into_iter()
        .filter(|s| s.enabled && s.signed_in)
        .map(|s| s.label)
        .collect()
}

/// One registered account, as much of it as somebody outside this file needs
/// to judge a name against: whether it exists, and if so whether it could take
/// work at all. No caps and no allowance — those are `accounts.ts`'s to weigh,
/// and a reading taken here would be a second waterfall.
pub struct Seat {
    pub label: String,
    /// The tier — see [`Account::priority`].
    pub priority: i64,
    pub enabled: bool,
    pub signed_in: bool,
}

/// Every registered account, in the order work falls through them. Degrades to
/// empty for [`usable_labels`]' reason. `spawn.rs` answers a card naming the
/// account a child should start on from this, and `limits.rs`'s `accounts` tool
/// is how a card learns the names in the first place.
pub fn registry(app: &AppHandle, conn: &rusqlite::Connection) -> Vec<Seat> {
    let Ok(mut stmt) =
        conn.prepare("SELECT label, enabled, priority FROM account ORDER BY priority, rank, label")
    else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map([], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))
    }) else {
        return Vec::new();
    };
    rows.filter_map(Result::ok)
        .map(|(label, enabled, priority)| Seat {
            signed_in: signed_in(app, &label),
            enabled: enabled != 0,
            priority,
            label,
        })
        .collect()
}

/// Add an account to the registry, at the end of the order.
///
/// Registering and signing in are two gestures, not one: an account can exist
/// in the order with no credential yet (`accounts.ts` reports it `unusable` and
/// says what to do), and a store can exist for a label nobody has registered.
/// Keeping them apart is what lets the panel show "signed in elsewhere, add it?"
/// rather than silently adopting whatever is on disk.
#[tauri::command]
pub fn add_account(store: State<'_, Store>, label: String) -> Result<(), String> {
    if !is_label(&label) {
        return Err("an account name may use letters, digits, dot, dash and underscore".into());
    }
    let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
    let next: i64 = conn
        .query_row("SELECT COALESCE(MAX(rank), -1) + 1 FROM account", [], |r| r.get(0))
        .unwrap_or(0);
    /* A tier of its own, at the end. Joining the last tier would be a new
       account silently declared equivalent to one you are already spending, and
       an account added is an account nobody has said anything about yet — the
       same argument `mergeAccounts` makes about an import landing below
       everything here. `COALESCE(MAX, 0) + 1`, so the first account on a fresh
       wall is priority 1 and agrees with what `migrate_v30` leaves. */
    let tier: i64 = conn
        .query_row("SELECT COALESCE(MAX(priority), 0) + 1 FROM account", [], |r| r.get(0))
        .unwrap_or(1);
    conn.execute(
        "INSERT INTO account (label, rank, priority, enabled, caps, added_at)
         VALUES (?1, ?2, ?3, 1, '{}', ?4)
         ON CONFLICT(label) DO NOTHING",
        rusqlite::params![label, next, tier, crate::store::now()],
    )
    .map_err(|e| format!("add account: {e}"))?;
    Ok(())
}

/// Forget an account. **Leaves its credential store alone** — removing a row
/// from a list is not a gesture anybody expects to sign them out of a
/// subscription, and a re-added label picks its store straight back up. Signing
/// out is its own item, worded as what it is.
#[tauri::command]
pub fn remove_account(store: State<'_, Store>, label: String) -> Result<(), String> {
    store
        .0
        .lock()
        .map_err(|_| "the store is wedged".to_string())?
        .execute("DELETE FROM account WHERE label = ?1", rusqlite::params![label])
        .map_err(|e| format!("remove account: {e}"))?;
    Ok(())
}

/// Sign an account out of Skein by deleting its credential store.
///
/// Deliberately not `remove_dir_all` on the store root or anything above it: the
/// path is built through `store_dir`, which refuses a label that is not a single
/// path component, and only the one directory is removed. Kept apart from
/// `remove_account` for the reason stated there.
#[tauri::command]
pub fn sign_out(app: AppHandle, label: String) -> Result<(), String> {
    let dir = store_dir(&app, &label)?;
    if dir.is_dir() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("could not sign that account out: {e}"))?;
    }
    Ok(())
}

/// Set the whole order at once, from the list the panel is showing.
///
/// The order is the feature — it is what makes the waterfall a waterfall — so
/// it is written as one transaction rather than a rank per call. A reorder that
/// half-applied would leave two accounts claiming the same rank and the tie
/// broken by label, which is a wall quietly spending the wrong subscription.
#[tauri::command]
pub fn reorder_accounts(store: State<'_, Store>, labels: Vec<String>) -> Result<(), String> {
    let mut conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("reorder accounts: {e}"))?;
    for (i, label) in labels.iter().enumerate() {
        tx.execute(
            "UPDATE account SET rank = ?1 WHERE label = ?2",
            rusqlite::params![i as i64, label],
        )
        .map_err(|e| format!("reorder accounts: {e}"))?;
    }
    tx.commit().map_err(|e| format!("reorder accounts: {e}"))?;
    Ok(())
}

/// Put one account in a tier.
///
/// **One row at a time, unlike `reorder_accounts` above**, and the difference is
/// worth stating because the two look like the same gesture. A rank is only
/// meaningful *against the other ranks*, so a half-applied reorder leaves two
/// accounts claiming one position and the tie broken by label — a wall quietly
/// spending the wrong subscription, which is why that one is a transaction over
/// the whole list. A priority is meaningful on its own: it is the tier this
/// account is in, two accounts sharing one is not a collision but the entire
/// point of the feature, and there is no arrangement of the other rows that can
/// make this row's number wrong. So there is nothing here for a transaction to
/// protect, and writing one row keeps the panel's gesture and the store's write
/// the same size.
///
/// Clamped to 1 rather than refused. The column is 1-based, the panel's field is
/// `min="1"`, and a zero arriving from anywhere else is somebody meaning "first"
/// — refusing it would leave a row in a tier nobody can name.
#[tauri::command]
pub fn set_account_priority(
    store: State<'_, Store>,
    label: String,
    priority: i64,
) -> Result<(), String> {
    store
        .0
        .lock()
        .map_err(|_| "the store is wedged".to_string())?
        .execute(
            "UPDATE account SET priority = ?1 WHERE label = ?2",
            rusqlite::params![priority.max(1), label],
        )
        .map_err(|e| format!("set priority: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn set_account_enabled(
    store: State<'_, Store>,
    label: String,
    enabled: bool,
) -> Result<(), String> {
    store
        .0
        .lock()
        .map_err(|_| "the store is wedged".to_string())?
        .execute(
            "UPDATE account SET enabled = ?1 WHERE label = ?2",
            rusqlite::params![enabled as i64, label],
        )
        .map_err(|e| format!("set account: {e}"))?;
    Ok(())
}

/// Set the ceilings for one account. `caps` is `{ "session": 80 }` and friends;
/// an empty object means no ceiling of yours on any window, which leaves the
/// server's.
#[tauri::command]
pub fn set_account_caps(
    store: State<'_, Store>,
    label: String,
    caps: serde_json::Value,
) -> Result<(), String> {
    if !caps.is_object() {
        return Err("caps must be an object of window kind to percentage".into());
    }
    store
        .0
        .lock()
        .map_err(|_| "the store is wedged".to_string())?
        .execute(
            "UPDATE account SET caps = ?1 WHERE label = ?2",
            rusqlite::params![caps.to_string(), label],
        )
        .map_err(|e| format!("set caps: {e}"))?;
    Ok(())
}

/// Labels with a credential store that no registered account claims. Lets the
/// panel offer an account signed in from a terminal, or left behind by a
/// `remove`, rather than adopting it silently.
#[tauri::command]
pub fn stored_accounts(app: AppHandle) -> Result<Vec<String>, String> {
    let root = match store_root(&app) {
        Ok(d) if d.is_dir() => d,
        _ => return Ok(Vec::new()),
    };
    let mut out = Vec::new();
    let entries = std::fs::read_dir(&root).map_err(|e| format!("read account stores: {e}"))?;
    for entry in entries.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(|s| s.to_string()) else {
            continue;
        };
        /* A directory with no credential in it is not an account anybody can
           be offered — it is what `add` then abandoning a sign-in leaves. */
        if is_label(&name) && entry.path().join(".credentials.json").is_file() {
            out.push(name);
        }
    }
    out.sort();
    Ok(out)
}

/* ── signing in ────────────────────────────────────────────────────────────*/

/* It lives in `signin.rs`, which spawns `claude auth login` on pipes with this
   module's `store_dir` in its environment. It used to be here, as a PowerShell
   script launched in a real terminal, because the command it ran then was
   `claude setup-token` — an ink TUI that emits nothing on pipes. `auth login`
   is not that: it is `process.stdout.write` and a readline, so the window it
   was given was inherited rather than needed. See that module's header. */

/// One account's credential off the disk, or `None` if there is not one there.
///
/// Deliberately not public: everything outside this module that wants to know
/// about a credential wants `signed_in` or `lapsed`, and a helper handing back
/// the whole thing is a helper somebody reaches for by accident.
fn read_credential(app: &AppHandle, label: &str) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(credential_path(app, label).ok()?).ok()?;
    serde_json::from_str(&text).ok()
}

/* ── a sign-in never leaves its machine ────────────────────────────────────
 *
 * This module used to be able to write every store into a sign-ins file and
 * install one from it on the other machine — the one place it handled a
 * credential deliberately. It cannot any more, and the reason is a measurement
 * rather than a preference: **a refresh token rotates on use.** Read out of the
 * CLI's own refresh code first (accounts.md, *Does a refresh token rotate on
 * use?*), then seen on 2026-10-19 — `tools/probe-rotation.ts` found all four
 * stores on QUEERISFREEDOM had come back from a refresh holding a new refresh
 * token. So a copy on a second machine is two machines spending one chain, and
 * whichever refreshes second is refused and signed out: `lyss` there was found
 * that morning with its tokens cleared by the CLI, nineteen days before its own
 * refresh stamp ran out. Lyss: *"I don't want machines to log each other out."*
 * Signing a machine in from another wall replaces the carry, and each machine
 * gets a chain of its own.
 */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_label_is_a_path_component_and_is_checked_as_one() {
        assert!(is_label("work"));
        assert!(is_label("team-2"));
        assert!(!is_label(""));
        assert!(!is_label("../../etc"));
        assert!(!is_label("a\\b"));
        assert!(!is_label("a/b"));
        assert!(!is_label("with space"));
    }

    /// The label names a directory that `sign_out` deletes **recursively**, so
    /// this check is the only thing between a bad label and somebody's home
    /// directory. `.` and `..` are the dangerous pair: both pass a plain
    /// character-class test, because a dot is legal in a real label, and both
    /// resolve *upward* — `..` to `~/.claude`, `.` to the root holding every
    /// account's store. Neither mattered when an account was a file called
    /// `<label>.tok`; both are catastrophic now.
    #[test]
    fn a_label_that_would_escape_its_directory_is_refused() {
        for bad in [".", "..", "...", "../..", "..\\..", "a/../../b", "/", "\\"] {
            assert!(!is_label(bad), "{bad:?} must not be a usable label");
        }
        /* And a dot in an otherwise real label is still fine, which is why the
           character set could not simply drop it. */
        assert!(is_label("work.2"));
        assert!(is_label("a.b.c"));
    }

    /// An idle reserve is dead only when both stamps have gone, and a stamp that
    /// is simply absent is never a reason to write an account off.
    #[test]
    fn a_credential_lapses_only_when_nothing_is_left_to_refresh_with() {
        let now = 1_790_000_000_000i64;
        let cred = |access: Option<i64>, refresh: Option<i64>, token: &str| {
            let mut o = serde_json::json!({ "accessToken": "x", "refreshToken": token });
            if let Some(a) = access {
                o["expiresAt"] = a.into();
            }
            if let Some(r) = refresh {
                o["refreshTokenExpiresAt"] = r.into();
            }
            serde_json::json!({ "claudeAiOauth": o })
        };
        // The ordinary idle case: access lapsed, refresh token still good.
        assert!(!lapsed_in(&cred(Some(now - 1), Some(now + 86_400_000), "r"), now));
        // The refresh stamp alone proves less than it seems.
        assert!(!lapsed_in(&cred(Some(now + 1), Some(now - 1), "r"), now));
        // Both gone: `personal` on this machine, ten days past.
        assert!(lapsed_in(&cred(Some(now - 1), Some(now - 864_000_000), "r"), now));
        // The CLI's own "signed out" marking needs no second stamp.
        assert!(lapsed_in(&cred(Some(now + 1), None, ""), now));
        // Absence is not a lapse.
        assert!(!lapsed_in(&cred(None, None, "r"), now));
        assert!(!lapsed_in(&serde_json::json!({}), now));
    }

}
