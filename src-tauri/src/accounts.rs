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
//! second to refresh is signed out. The bottom of this file is what replaced it —
//! the check that finds a copy made before, and the gate that refuses one.
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
    /// Who it signs in as — learned off its own credential
    /// (`limits::learn_identity`), empty until then. The address and organisation
    /// are for the panel to say; the identity is what other walls match on.
    pub identity: String,
    pub identity_email: String,
    pub identity_org: String,
    /// Who last changed each synced field, and when — one entry per field that
    /// has ever been changed under `accountsync`, which is what the panel's
    /// sync line reads. Empty for a row nobody has touched since the upgrade.
    pub synced: Vec<Synced>,
    /// The sign-in is a retired copy of another machine's chain, refused until
    /// it is signed in again here ([`is_copy`]).
    pub copied: bool,
}

/// One synced field's last write, as the panel reads it. The value is on the
/// row; this is only whose word it is.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Synced {
    pub field: String,
    pub at: i64,
    pub host: String,
}

#[tauri::command]
pub fn list_accounts(app: AppHandle, store: State<'_, Store>) -> Result<Vec<Account>, String> {
    let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT label, rank, enabled, caps, priority, identity, identity_email, identity_org
             FROM account ORDER BY priority, rank, label",
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
                (r.get::<_, String>(5)?, r.get::<_, String>(6)?, r.get::<_, String>(7)?),
            ))
        })
        .map_err(|e| format!("read accounts: {e}"))?;

    let mut out = Vec::new();
    for row in rows {
        let (label, rank, enabled, caps, priority, (identity, identity_email, identity_org)) =
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
            identity,
            identity_email,
            identity_org,
            synced: Vec::new(),
            copied: false,
        });
    }
    drop(stmt);
    for a in &mut out {
        a.synced = crate::accountsync::registers_of(&conn, &a.label)
            .into_iter()
            .map(|r| Synced { field: r.field, at: r.at, host: r.host })
            .collect();
        a.copied = a.signed_in && is_copy(&app, &conn, &a.label);
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
        .filter(|s| s.enabled && s.signed_in && !s.copied)
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
    /// A retired copy of another machine's sign-in — signed in by the file, and
    /// refused all the same ([`usable_store`]).
    pub copied: bool,
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
            copied: is_copy(app, conn, &label),
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
/// And under one stamp (`accountsync::stamp_all`), so on every other wall the
/// whole order wins or loses as a unit too.
#[tauri::command]
pub fn reorder_accounts(app: AppHandle, store: State<'_, Store>, labels: Vec<String>) -> Result<(), String> {
    {
        let mut conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
        let writes: Vec<(String, &str, serde_json::Value)> =
            labels.iter().enumerate().map(|(i, l)| (l.clone(), "rank", serde_json::json!(i as i64))).collect();
        crate::accountsync::stamp_all(&mut conn, &writes, &crate::flyway::key::host_name(), crate::store::now())
            .map_err(|e| format!("reorder accounts: {e}"))?;
    }
    changed(&app);
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
pub fn set_account_priority(app: AppHandle, label: String, priority: i64) -> Result<(), String> {
    set_field(&app, &label, "priority", serde_json::json!(priority.clamp(1, 1_000)))
}

#[tauri::command]
pub fn set_account_enabled(app: AppHandle, label: String, enabled: bool) -> Result<(), String> {
    set_field(&app, &label, "enabled", serde_json::json!(enabled))
}

/// Set the ceilings for one account. `caps` is `{ "session": 80 }` and friends;
/// an empty object means no ceiling of yours on any window, which leaves the
/// server's.
#[tauri::command]
pub fn set_account_caps(app: AppHandle, label: String, caps: serde_json::Value) -> Result<(), String> {
    if !caps.is_object() {
        return Err("caps must be an object of window kind to percentage".into());
    }
    set_field(&app, &label, "caps", caps)
}

/// One synced setting of one account, written the one way such a setting is
/// written: stamped (`accountsync::stamp`), so every wall on the flyway hears it,
/// and announced, so every reader on this one does. The panel's setters and a
/// card's agreed `set_account` both land here — two routes to one write, so the
/// tool cannot do something the panel would not.
pub fn set_field(app: &AppHandle, label: &str, field: &str, value: serde_json::Value) -> Result<(), String> {
    {
        let store = app.try_state::<Store>().ok_or("the store is not open")?;
        let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
        crate::accountsync::stamp(&conn, label, field, &value, &crate::flyway::key::host_name(), crate::store::now())?;
    }
    changed(app);
    Ok(())
}

/// The accounts changed — here, or because another wall said so. Every reader
/// re-reads: the waterfall (`waterfall.svelte.ts` listens for this and calls
/// `refresh`, so a cached registry cannot go on choosing an account switched off
/// on the other laptop), the panel through it, and the flyway, which says the
/// new picture to the walls it flies with.
pub fn changed(app: &AppHandle) {
    use tauri::Emitter;
    let _ = app.emit("accounts:changed", ());
    crate::flyway::link::accounting::changed(app);
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

/* ── a sign-in never leaves its machine ────────────────────────────────────
 *
 * This module used to be able to write every store into a
 * sign-ins file and install one from it on the other machine — the
 * one place it handled a credential deliberately. It cannot any more, and the
 * reason is a measurement rather than a preference: **a refresh token rotates on
 * use.** Read out of the CLI's own refresh code first (accounts.md, *Does a
 * refresh token rotate on use?*), then seen on 2026-10-19 — `tools/
 * probe-rotation.ts` found all four stores on QUEERISFREEDOM had come back from
 * a refresh holding a new refresh token. So a copy on a second machine is two
 * machines spending one chain, and whichever refreshes second is refused and
 * signed out: `lyss` there was found that morning with its tokens cleared by
 * the CLI, nineteen days before its own refresh stamp ran out. Lyss: *"I don't
 * want machines to log each other out."* The carry is gone; signing a machine in
 * from another wall replaces it, and each machine gets a chain of its own.
 *
 * What is left here is the half that finds a copy made before the carry went.
 * **A copy is the same chain on two machines**, and that is exactly what can be
 * compared without moving a token: each wall says, per identity, a digest of the
 * refresh token its store holds ([`chain_digest`] — salted, truncated, not
 * reversible into anything spendable) and how long ago its store was last
 * written. Two walls holding the same digest hold one chain. The two only stay
 * equal until either refreshes — after which one of them is already dead — so
 * this catches every copy that is still a hazard and none that is not: two
 * chains that differ are two sign-ins, which is the arrangement wanted.
 *
 * **Which of the two is the copy** is told by the file, not guessed. While the
 * digests match neither store has refreshed since the copy was made, so the
 * original was last written by its own sign-in or refresh and the copy by the
 * install, which came after. The store written more recently is the copy
 * (`flyway::accounts::is_the_copy`), and only that wall retires its sign-in. The
 * comparison is of two ages, each on its own wall's clock, so no two clocks are
 * compared; installs come days after the sign-ins they copied, so a few seconds
 * of drift in an age cannot flip it, and an exact tie goes by host name so the
 * two walls still agree.
 *
 * **Retired means refused**, by construction rather than by a warning: the row
 * records the digest it was retired at (`copied_digest`, schema v56), and
 * [`usable_store`] — what every spawn asks — refuses a store still holding that
 * chain. Signing in again here starts a new chain, the digest no longer matches,
 * and the account is usable again with nothing to clear.
 */

/// One account's credential off the disk, or `None` if there is not one there.
///
/// Deliberately not public: everything outside this module that wants to know
/// about a credential wants `signed_in`, a digest or an age, and a helper handing
/// back the whole thing is a helper somebody reaches for by accident.
fn read_credential(app: &AppHandle, label: &str) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(credential_path(app, label).ok()?).ok()?;
    serde_json::from_str(&text).ok()
}

/// A digest of the refresh-token chain `label`'s store holds, for telling a
/// copy of a sign-in from a sign-in of its own. `None` with no refresh token.
pub fn chain_digest(app: &AppHandle, label: &str, identity: &str) -> Option<String> {
    let cred = read_credential(app, label)?;
    let o = cred.get("claudeAiOauth").unwrap_or(&cred);
    let token = o.get("refreshToken").and_then(|v| v.as_str()).filter(|t| !t.is_empty())?;
    Some(digest_of(identity, token))
}

/// Salted with the identity so one digest names one account's chain, and cut to
/// 128 bits, which is plenty to tell two chains apart and nothing to spend.
fn digest_of(identity: &str, token: &str) -> String {
    let mut input = Vec::with_capacity(32 + identity.len() + token.len());
    input.extend_from_slice(b"volery-chain\0");
    input.extend_from_slice(identity.as_bytes());
    input.push(0);
    input.extend_from_slice(token.as_bytes());
    let d = ring::digest::digest(&ring::digest::SHA256, &input);
    d.as_ref()[..16].iter().map(|b| format!("{b:02x}")).collect()
}

/// How long ago `label`'s store was last written.
pub fn store_age_ms(app: &AppHandle, label: &str) -> Option<u64> {
    let modified = std::fs::metadata(credential_path(app, label).ok()?).ok()?.modified().ok()?;
    Some(std::time::SystemTime::now().duration_since(modified).map(|d| d.as_millis() as u64).unwrap_or(0))
}

/// Whether `label`'s store holds a sign-in retired as a copy of another
/// machine's: the row recorded a chain, and the store still holds it.
pub fn is_copy(app: &AppHandle, conn: &rusqlite::Connection, label: &str) -> bool {
    let row: Option<(Option<String>, String)> = conn
        .query_row(
            "SELECT copied_digest, identity FROM account WHERE label = ?1",
            rusqlite::params![label],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    match row {
        Some((Some(copied), identity)) => chain_digest(app, label, &identity).as_deref() == Some(copied.as_str()),
        _ => false,
    }
}

/// Retire `label`'s sign-in as a copy of another machine's chain.
pub fn retire_copy(conn: &rusqlite::Connection, label: &str, digest: &str) -> Result<bool, String> {
    conn.execute(
        "UPDATE account SET copied_digest = ?1 WHERE label = ?2 AND copied_digest IS NOT ?1",
        rusqlite::params![digest, label],
    )
    .map(|n| n > 0)
    .map_err(|e| format!("retire a copied sign-in: {e}"))
}

/// What a copied sign-in is told, everywhere one is refused.
pub const COPIED: &str =
    "this sign-in was copied from another machine and using it would log that machine out — sign in here instead";

/// Whether a child may be spawned on `label`'s store: signed in, and not a
/// retired copy. What `spawn_now` and an aside ask before naming a store to a
/// child, so a copy is refused by construction rather than warned about.
pub fn usable_store(app: &AppHandle, label: &str) -> Result<(), String> {
    if !signed_in(app, label) {
        return Err(format!("'{label}' is not signed in — sign in to it in the accounts panel"));
    }
    let copied = app
        .try_state::<Store>()
        .and_then(|s| s.0.lock().ok().map(|c| is_copy(app, &c, label)))
        .unwrap_or(false);
    if copied {
        return Err(format!("'{label}': {COPIED}"));
    }
    Ok(())
}


/* ── a card asking to change an account ────────────────────────────────────
 *
 * `set_account`: switch an account on or off, or move its caps, on the user's
 * yes. It was missing in exactly the way that bit on 2026-10-19 — `lyss` was
 * switched off on QUEERISFREEDOM, Lyss was at AU-LT-288, and neither she nor
 * any card could switch it back on from there, because the only way to write
 * the row was the panel on the machine it lived on.
 *
 * **It asks, always.** An account is money and a reserve somebody chose to
 * guard; a card deciding on its own to spend the reserve is the thing the tiers
 * exist to stop. So the call parks on a confirmation, the docket's shape
 * (`docket::Writing::Ask`), and because it is a `Settle::new` with evidence it
 * travels to whichever wall Lyss is at with nothing added to any list
 * (`ask::Confirm`, elsewhere.md, *Every confirmation travels*).
 *
 * **On a yes it is the panel's own write** — `set_field`, stamped by
 * `accountsync` — so the change reaches every wall on the flyway that knows the
 * account, and the tool cannot do anything the panel would not. Caps are merged
 * into the ones already set rather than replacing them, with `null` taking one
 * away, so a card asked to cap the week does not silently lift the cap on the
 * session. Re-read at the moment of the yes, so an answer given ten minutes
 * later writes against the account as it stands then.
 */

pub const SET_ACCOUNT_TOOL: &str = "set_account";

/// The two words a click sends, and the only two `approved` reads.
const CHANGE_IT: &str = "change it";
const LEAVE_IT: &str = "leave it as it is";

const REASON_MOST: usize = 600;

pub fn set_account_schema() -> serde_json::Value {
    serde_json::json!({
        "name": SET_ACCOUNT_TOOL,
        "description":
            "Ask the user to switch one of this wall's Claude accounts on or off, or to change its \
             caps — the percentage of a usage window past which no new work starts on it. The call \
             parks on a confirmation that reaches the user on whichever machine they are at, and \
             nothing changes unless they say yes.\n\n\
             Use it when the user asks for it, or when work is held for want of an account and the \
             user would plainly want a switched-off one back on — and then say why in `reason`, \
             since that sentence is what they decide on. Never to get round a cap they set: a cap \
             is a reserve they chose to keep.\n\n\
             A change is made the way the accounts panel makes it, so it reaches every wall on the \
             flyway that knows the account. `account` is a label from `mcp__skein__accounts`. \
             `caps` is merged into the caps already set: `{\"session\": 80}` caps the five-hour \
             window at 80% and leaves the others, `null` for a window takes its cap away.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "account": { "type": "string", "description": "The account's label on this wall." },
                "enabled": { "type": "boolean", "description": "Switch it on (true) or off (false)." },
                "caps": {
                    "type": "object",
                    "description": "Window kind to percentage ceiling 0–100, or null to remove that cap. Kinds as the accounts listing names them: session, weekly_all, weekly_scoped.",
                    "additionalProperties": { "type": ["number", "null"] }
                },
                "reason": { "type": "string", "description": "Why — the sentence the user decides on." }
            },
            "required": ["account", "reason"]
        }
    })
}

/// What one call asks to change, read and checked against the row as it is.
#[derive(Debug, Clone, PartialEq)]
struct Change {
    label: String,
    enabled: Option<bool>,
    /// The whole caps object after the merge, if caps were asked about.
    caps: Option<serde_json::Value>,
}

/// One account's settings as they stand: on/off, the caps, who it signs in as.
fn standing(conn: &rusqlite::Connection, label: &str) -> Option<(bool, serde_json::Value, String, String)> {
    conn.query_row(
        "SELECT enabled, caps, identity, identity_email FROM account WHERE label = ?1",
        rusqlite::params![label],
        |r| {
            let caps: String = r.get(1)?;
            Ok((
                r.get::<_, i64>(0)? != 0,
                serde_json::from_str(&caps).unwrap_or_else(|_| serde_json::json!({})),
                r.get(2)?,
                r.get(3)?,
            ))
        },
    )
    .ok()
}

/// The arguments, held to their shape: a reason, and at least one thing that
/// would actually change. Pure over the row, so every refusal is tested
/// without a store.
fn read_change(args: &serde_json::Value, now_enabled: bool, now_caps: &serde_json::Value) -> Result<Change, String> {
    let label = args.get("account").and_then(|v| v.as_str()).map(str::trim).unwrap_or("").to_string();
    let enabled = match args.get("enabled") {
        None | Some(serde_json::Value::Null) => None,
        Some(v) => Some(v.as_bool().ok_or("`enabled` is true or false")?),
    };
    let caps = match args.get("caps") {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::Object(asked)) => {
            let mut merged = now_caps.as_object().cloned().unwrap_or_default();
            for (kind, v) in asked {
                match v {
                    serde_json::Value::Null => {
                        merged.remove(kind);
                    }
                    n => {
                        let pct = n.as_f64().filter(|p| p.is_finite() && (0.0..=100.0).contains(p)).ok_or_else(|| {
                            format!("a cap is a percentage from 0 to 100, or null to remove it — {kind} was {n}")
                        })?;
                        merged.insert(kind.clone(), serde_json::json!(pct));
                    }
                }
            }
            let merged = serde_json::Value::Object(merged);
            Some(crate::flyway::accounts::normal("caps", &merged).ok_or("those caps name a window kind that is not one")?)
        }
        Some(_) => return Err("`caps` is an object of window kind to percentage".into()),
    };
    let enabled = enabled.filter(|e| *e != now_enabled);
    let caps = caps.filter(|c| crate::flyway::accounts::normal("caps", now_caps).as_ref() != Some(c));
    if enabled.is_none() && caps.is_none() {
        return Err("nothing to change — the account already stands as asked, so the user has not been asked".into());
    }
    Ok(Change { label, enabled, caps })
}

/// The change in words, for the question and the evidence.
fn say_change(c: &Change, now_caps: &serde_json::Value) -> String {
    let mut parts = Vec::new();
    if let Some(e) = c.enabled {
        parts.push(if e {
            "switch it on — it can take work again".to_string()
        } else {
            "switch it off — no new work starts on it".to_string()
        });
    }
    if let Some(caps) = &c.caps {
        let pct = |v: Option<&serde_json::Value>| {
            v.and_then(|n| n.as_f64()).map(|p| format!("{p:.0}%")).unwrap_or_else(|| "no cap".into())
        };
        let num = |v: Option<&serde_json::Value>| v.and_then(|n| n.as_f64());
        let mut kinds: Vec<String> = caps
            .as_object()
            .into_iter()
            .flat_map(|o| o.keys().cloned())
            .chain(now_caps.as_object().into_iter().flat_map(|o| o.keys().cloned()))
            .collect();
        kinds.sort();
        kinds.dedup();
        let moved: Vec<String> = kinds
            .iter()
            .filter(|k| num(caps.get(k.as_str())) != num(now_caps.get(k.as_str())))
            .map(|k| format!("{k} {} → {}", pct(now_caps.get(k.as_str())), pct(caps.get(k.as_str()))))
            .collect();
        parts.push(format!("caps: {}", moved.join(", ")));
    }
    parts.join("; ")
}

fn change_question(label: &str, who: &str, change: &str, reason: &str, reaches: &str) -> serde_json::Value {
    serde_json::json!({
        "questions": [{
            "header": format!("account {label}"),
            "question": format!(
                "A card asks to change the **{label}** account{who}.\n\n**The change:** {change}\n\n\
                 **It says:**\n\n---\n\n{reason}\n\n---\n\n{reaches}"
            ),
            "options": [
                { "label": CHANGE_IT, "detail": "Made as the accounts panel would make it." },
                { "label": LEAVE_IT, "detail": "Nothing changes. The card is told you said no." }
            ]
        }]
    })
}

/// The tool, as `ask.rs` calls it — `docket::writes`' contract.
pub(crate) fn writes(app: &AppHandle, _caller: &str, tool: &str, args: &serde_json::Value) -> Option<crate::docket::Writing> {
    use crate::docket::Writing;
    if tool != SET_ACCOUNT_TOOL {
        return None;
    }
    let reason = args.get("reason").and_then(|v| v.as_str()).map(str::trim).unwrap_or("");
    if reason.is_empty() {
        return Some(Writing::Now(
            "say why in `reason` — it is the sentence the user decides on, so nothing was asked.".into(),
        ));
    }
    let reason = crate::clip::preview(&crate::clean::scrub(reason), REASON_MOST);
    let label = args.get("account").and_then(|v| v.as_str()).map(str::trim).unwrap_or("").to_string();
    let Some(store) = app.try_state::<Store>() else {
        return Some(Writing::Now("the wall's store is unavailable, so nothing was asked.".into()));
    };
    let Some((now_enabled, now_caps, identity, email)) = store.0.lock().ok().and_then(|c| standing(&c, &label)) else {
        return Some(Writing::Now(format!(
            "there is no account called {label:?} on this wall — `mcp__skein__accounts` lists the labels. Nothing was asked."
        )));
    };
    let change = match read_change(args, now_enabled, &now_caps) {
        Ok(c) => c,
        Err(why) => return Some(Writing::Now(why)),
    };
    let said = say_change(&change, &now_caps);
    let who = if email.is_empty() { String::new() } else { format!(" ({email})") };
    let reaches = if identity.is_empty() {
        "Its sign-in has not been identified yet, so the change is made on this wall alone.".to_string()
    } else {
        "The change reaches every wall on the flyway that knows this account.".to_string()
    };
    let stakes = match change.enabled {
        Some(true) => "Work may start spending this subscription straight away.",
        Some(false) => "Nothing new starts on it; cards already on it move at their next turn.",
        None => "The caps decide when the wall stops sending work to it.",
    };
    let confirm = crate::ask::Confirm::new(format!("change the {label} account"))
        .fact("account", if email.is_empty() { label.clone() } else { format!("{label} — {email}") })
        .fact("the change", said.clone())
        .fact("where", reaches.clone())
        .why(Some(&reason))
        .stakes(stakes);
    let question = change_question(&label, &who, &said, &reason, &reaches);
    Some(Writing::Ask {
        question,
        settle: crate::ask::Settle::new(confirm, move |app, answer| settle_change(app, answer, &change, &reaches)),
    })
}

/// What a yes, a no or silence does — re-reading the account at the moment of
/// the answer, which may be long after the question.
fn settle_change(app: &AppHandle, answer: Option<&str>, change: &Change, reaches: &str) -> String {
    let label = &change.label;
    let Some(answer) = answer else {
        return "nobody answered, so the account was not changed. Carry on without it and say that you asked.".into();
    };
    if !crate::docket::approved(answer, CHANGE_IT) {
        return if crate::docket::approved(answer, LEAVE_IT) {
            format!("the user said no, so {label} is as it was. Do not ask again for the same thing.")
        } else {
            format!(
                "the user pressed neither button. They said: {:?}. Nothing was changed; act on what they said.",
                answer.trim()
            )
        };
    }
    let current = app.try_state::<Store>().and_then(|s| s.0.lock().ok().and_then(|c| standing(&c, label)));
    let Some((now_enabled, now_caps, _, _)) = current else {
        return format!("the user agreed, but {label} is no longer on this wall, so nothing was changed.");
    };
    let mut done = Vec::new();
    if let Some(e) = change.enabled.filter(|e| *e != now_enabled) {
        if let Err(why) = set_field(app, label, "enabled", serde_json::json!(e)) {
            return format!("the user agreed, but the change could not be written: {why}");
        }
        done.push(if e { "switched on" } else { "switched off" });
    }
    if let Some(caps) = change.caps.clone() {
        if crate::flyway::accounts::normal("caps", &now_caps).as_ref() != Some(&caps) {
            if let Err(why) = set_field(app, label, "caps", caps) {
                return format!("the user agreed, but the caps could not be written: {why}");
            }
            done.push("caps changed");
        }
    }
    if done.is_empty() {
        return format!("the user agreed, and {label} already stood as asked — somebody changed it in the meantime.");
    }
    format!("the user agreed: {label} is {}. {reaches}", done.join(" and "))
}

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


    /// What a card may ask, read against the row as it stands: a merge into the
    /// caps already set, `null` taking one away, and nothing asked of the user
    /// when nothing would change.
    #[test]
    fn a_change_is_merged_into_what_stands_and_refused_when_it_moves_nothing() {
        let now = serde_json::json!({ "session": 80.0, "weekly_all": 90.0 });
        let c = read_change(&serde_json::json!({ "account": "lyss", "caps": { "weekly_all": 70, "session": null } }), true, &now).unwrap();
        assert_eq!(c.caps, Some(serde_json::json!({ "weekly_all": 70.0 })));
        assert_eq!(c.enabled, None);
        assert_eq!(say_change(&c, &now), "caps: session 80% → no cap, weekly_all 90% → 70%");

        let on = read_change(&serde_json::json!({ "account": "lyss", "enabled": true }), false, &now).unwrap();
        assert_eq!(on.enabled, Some(true));
        assert!(say_change(&on, &now).starts_with("switch it on"));

        /* Already as asked: refused, so nobody is interrupted to agree to nothing. */
        assert!(read_change(&serde_json::json!({ "account": "lyss", "enabled": true }), true, &now).is_err());
        assert!(read_change(&serde_json::json!({ "account": "lyss", "caps": { "session": 80 } }), true, &now).is_err());
        assert!(read_change(&serde_json::json!({ "account": "lyss" }), true, &now).is_err());
        /* Out of shape. */
        assert!(read_change(&serde_json::json!({ "account": "lyss", "caps": { "session": 140 } }), true, &now).is_err());
        assert!(read_change(&serde_json::json!({ "account": "lyss", "caps": 80 }), true, &now).is_err());
        assert!(read_change(&serde_json::json!({ "account": "lyss", "enabled": "yes" }), true, &now).is_err());
    }

    /// The labels the question offers are the ones the settle reads, and the
    /// question parks with a confirmation block so it reaches the user's wall.
    #[test]
    fn the_question_offers_the_words_the_settle_reads() {
        let q = change_question("lyss", " (l@example.com)", "switch it on", "held for an account", "reaches");
        let labels: Vec<&str> = q["questions"][0]["options"].as_array().unwrap().iter().map(|o| o["label"].as_str().unwrap()).collect();
        assert_eq!(labels, vec![CHANGE_IT, LEAVE_IT]);
        assert!(crate::docket::approved("Change it ", CHANGE_IT));
        let schema = set_account_schema();
        assert_eq!(schema["name"], SET_ACCOUNT_TOOL);
        assert_eq!(schema["inputSchema"]["required"], serde_json::json!(["account", "reason"]));
    }
    /// A digest names one chain of one account, is the same wherever it is
    /// computed, and carries nothing of the token: a different token or a
    /// different account gives a different digest, and none of the token's
    /// bytes appear in it.
    #[test]
    fn a_chain_digest_tells_chains_apart_and_spends_nothing() {
        let token = "sk-ant-ort01-secretsecretsecret";
        let a = digest_of("acct:org", token);
        assert_eq!(a, digest_of("acct:org", token), "the same chain reads the same on both walls");
        assert_ne!(a, digest_of("acct:org", "sk-ant-ort01-rotated"), "a refresh is a new chain");
        assert_ne!(a, digest_of("other:org", token), "salted by the account it belongs to");
        assert_eq!(a.len(), 32);
        assert!(!a.contains("secret") && !a.contains("sk-ant"));
    }

}
