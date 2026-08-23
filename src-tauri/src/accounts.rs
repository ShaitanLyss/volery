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
//! **The exception is at the bottom of this file and is deliberate.** Carrying
//! the sign-ins to a second machine is the one thing the absolute form of that
//! rule made impossible, and it was the thing actually wanted: three
//! subscriptions here are three browser round trips to repeat over there. So
//! `save_accounts_file` reads the stores, `install_signin` writes one, and
//! `Carried` holds what a document was carrying until a panel closes. The bounds
//! on it are stated where it is, and the important one is that **the front end
//! still never sees a token** — `Summary` is two timestamps and a plan name.
//!
//! Nothing here logs or formats a credential, and `Account` — the struct that
//! crosses into the webview on every ordinary read — carries no secret and no
//! path to one.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
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

/* ── the registry ──────────────────────────────────────────────────────────*/

/// One account as the front end sees it. No credential and no path to one —
/// **this is what crosses into the webview.**
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub label: String,
    pub rank: i64,
    pub enabled: bool,
    /// Window `kind` → percentage ceiling. Free-form because the rate limiter's
    /// window vocabulary moves; see `migrate_v16`.
    pub caps: serde_json::Value,
    /// Whether this account's store holds a credential.
    pub signed_in: bool,
}

#[tauri::command]
pub fn list_accounts(app: AppHandle, store: State<'_, Store>) -> Result<Vec<Account>, String> {
    let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
    let mut stmt = conn
        .prepare("SELECT label, rank, enabled, caps FROM account ORDER BY rank, label")
        .map_err(|e| format!("read accounts: {e}"))?;
    let rows = stmt
        .query_map([], |r| {
            let label: String = r.get(0)?;
            let caps: String = r.get(3)?;
            Ok((label, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, caps))
        })
        .map_err(|e| format!("read accounts: {e}"))?;

    let mut out = Vec::new();
    for row in rows {
        let (label, rank, enabled, caps) = row.map_err(|e| format!("read accounts: {e}"))?;
        let has = signed_in(&app, &label);
        out.push(Account {
            caps: serde_json::from_str(&caps).unwrap_or_else(|_| serde_json::json!({})),
            signed_in: has,
            label,
            rank,
            enabled: enabled != 0,
        });
    }
    Ok(out)
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
    conn.execute(
        "INSERT INTO account (label, rank, enabled, caps, added_at)
         VALUES (?1, ?2, 1, '{}', ?3)
         ON CONFLICT(label) DO NOTHING",
        rusqlite::params![label, next, crate::store::now()],
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

/* ── carrying the sign-ins to another machine ──────────────────────────────
 *
 * **This module's headline property changes here, and it is worth marking where
 * the line moved to rather than moving it quietly.** Everything above is built
 * on Skein handling no secret at all: it names a *directory* and the CLI does
 * the rest. That is still true of every path a card takes — spawning, swapping,
 * signing in, reading an allowance. What is no longer true is the absolute form
 * of it, because the thing the absolute form made impossible turned out to be
 * the thing that was actually wanted: three subscriptions signed in here are
 * three browser round trips to repeat on the second machine, and a wall that
 * carries its whole layout across but not those is answering the easy half.
 *
 * So a credential can be written into a file you picked and read back out of
 * one, and these are the bounds on it:
 *
 *  - **The front end never sees a token.** `save_accounts_file` splices the
 *    credentials in on the way out; `load_accounts_file` takes them straight
 *    back out on the way in and parks them here. What crosses into the webview
 *    is `Summary` — two timestamps and a plan name. The webview is the part of
 *    this app that renders untrusted content, and a token is one `console.log`
 *    or one injected script away from leaving it, so this is worth a command
 *    rather than a convenience.
 *  - **Nothing is installed without being asked for.** Loading a document
 *    parks it; `install_signin` is a separate call taking one label at a time,
 *    and every question of *which* of them may happen without a press is
 *    policy, which lives in `accounts.ts::planSignins` with the rest of it.
 *  - **What is parked is dropped.** `drop_carried` runs when the panel closes.
 *    A credential in a mutex for as long as a panel is open is a smaller thing
 *    than one there for the life of the process, and this is the cheapest
 *    difference in the file.
 *
 * And what it costs, said plainly, because the file is the part no code here
 * can protect: **the document is plaintext, and anyone who can read it can
 * spend those subscriptions until you sign out.** No DPAPI — the store this
 * copies has none either — and no passphrase, which was offered and declined in
 * favour of a file. `.volery-accounts.json` is its own suffix rather than the
 * layout's `.volery.json` exactly so the artefact is recognisable for what it is
 * in a sync folder, a backup or a downloads directory, and `Accounts.svelte`
 * says the same sentence in the one place somebody is standing when they make
 * one.
 */

/// The suffix an accounts document is written with, and insisted on when one is
/// read. Deliberately not the layout's `.volery.json`: these two documents want
/// telling apart on sight, and the narrower verb is also what keeps these
/// commands from being a way to read or overwrite arbitrary files — the same
/// argument `portage.rs` makes about a command being reachable from anything
/// holding the IPC, a card's own agent included.
const DOC_SUFFIX: &str = ".volery-accounts.json";

/// Room for hundreds of accounts. Three with a credential apiece came to under
/// 2KB, measured 2026-08-22 against this machine's own stores; the ceiling is
/// not a limit anybody should meet but the thing that turns "the app hung" into
/// a sentence when the path picked is a disk image.
const DOC_CEILING: u64 = 1024 * 1024;

fn checked_doc(path: &str) -> Result<PathBuf, String> {
    let p = Path::new(path);
    if !p.is_absolute() {
        return Err(format!("{path} is not a full path"));
    }
    /* Compared lowercase, since a person typing a filename into a save dialog
       on Windows may well capitalise it and the filesystem does not care. */
    if !path.to_ascii_lowercase().ends_with(DOC_SUFFIX) {
        return Err(format!("an accounts document is a {DOC_SUFFIX} file"));
    }
    Ok(p.to_path_buf())
}

/// Credentials read out of a document and not yet installed, by the label the
/// *document* called them.
///
/// Keyed on the document's own label rather than the one they will land under,
/// because at this point nothing has decided that: a document's `lyss` may be
/// installed into a `lyss` created here, offered against a `lyss` that already
/// holds a credential, or declined altogether. `install_signin` takes both names
/// for exactly that reason.
#[derive(Default)]
pub struct Carried(pub Mutex<HashMap<String, serde_json::Value>>);

/// What the front end is told about a credential, and the whole of what it is
/// told.
///
/// Three fields, all optional, none of them spendable: how long the access
/// token has, how long the refresh token has, and which plan it is on. That is
/// enough for `accounts.ts` to say what a sign-in is worth and to work out
/// whether the one in a file is newer than the one already on this disk, and it
/// is nothing anybody could use.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub label: String,
    pub expires_at: Option<i64>,
    pub refresh_expires_at: Option<i64>,
    pub plan: Option<String>,
}

/// A credential read down to its summary.
///
/// Every field is looked for and none is required. The shape probed 2026-08-22
/// against this machine's stores, written by claude 2.1.235, is
/// `{ claudeAiOauth: { accessToken, refreshToken, expiresAt,
/// refreshTokenExpiresAt, scopes, subscriptionType, rateLimitTier } }` — but
/// this runs against a file that may have been written by an older CLI or a
/// newer one, so a missing stamp becomes `None` and the face says it does not
/// know rather than this refusing the credential. Nothing about installability
/// hangs on it: what is lost with a missing stamp is only the ability to say how
/// long the thing has left.
///
/// `unwrap_or(cred)` for the same reason one rung down — a credential handed
/// over already unwrapped summarises rather than coming back empty.
pub fn summarize(label: &str, cred: &serde_json::Value) -> Summary {
    let o = cred.get("claudeAiOauth").unwrap_or(cred);
    Summary {
        label: label.to_string(),
        expires_at: o.get("expiresAt").and_then(|v| v.as_i64()),
        refresh_expires_at: o.get("refreshTokenExpiresAt").and_then(|v| v.as_i64()),
        plan: o
            .get("subscriptionType")
            .and_then(|v| v.as_str())
            .map(str::to_string),
    }
}

/// One account's credential off the disk, or `None` if there is not one there.
///
/// Deliberately not public: everything outside this module that wants to know
/// about a credential wants `signed_in` or a `Summary`, and a helper handing
/// back the whole thing is a helper somebody reaches for by accident.
fn read_credential(app: &AppHandle, label: &str) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(credential_path(app, label).ok()?).ok()?;
    serde_json::from_str(&text).ok()
}

/// What a save actually managed.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    /// Labels whose credential went into the file.
    pub signins: Vec<String>,
    /// Labels that were asked for and had nothing to carry. Reported rather
    /// than skipped: "I exported my sign-ins" and "two of the four had none in
    /// them" must not be the same silence, and the second one is only findable
    /// here — on the other machine it looks like an account that never worked.
    pub missing: Vec<String>,
}

/// Write an accounts document, splicing in the credentials for the labels
/// asked for.
///
/// The document itself is built by `accounts.ts::exportAccounts` and arrives as
/// parsed JSON rather than text, so this only has to reach into the rows it was
/// told about — one owner for the format, in the pure module where it is tested,
/// and no second copy of it here to drift.
///
/// `async` and `off_main` because it is a blocking write, and a blocking call on
/// the main thread stops every card on the wall being painted for as long as it
/// lasts. See CLAUDE.md on `off_main`.
#[tauri::command]
pub async fn save_accounts_file(
    app: AppHandle,
    path: String,
    doc: serde_json::Value,
    signins: Vec<String>,
) -> Result<Saved, String> {
    let target = checked_doc(&path)?;
    crate::off_main(move || {
        let mut doc = doc;
        let want: std::collections::HashSet<String> = signins.into_iter().collect();
        let mut wrote: Vec<String> = Vec::new();
        let mut missing: Vec<String> = Vec::new();

        let rows = doc
            .get_mut("accounts")
            .and_then(|v| v.as_array_mut())
            .ok_or_else(|| "there are no accounts in that document".to_string())?;
        for row in rows.iter_mut() {
            let Some(obj) = row.as_object_mut() else { continue };
            let label = match obj.get("label").and_then(|v| v.as_str()) {
                Some(l) if want.contains(l) => l.to_string(),
                _ => continue,
            };
            match read_credential(&app, &label) {
                Some(cred) => {
                    obj.insert("signIn".into(), cred);
                    wrote.push(label);
                }
                None => missing.push(label),
            }
        }

        let text = serde_json::to_string_pretty(&doc)
            .map_err(|e| format!("could not write that document: {e}"))?;
        /* The parent is not created — a save dialog only ever returns a
           directory that exists, and creating one here would mean a typo in a
           path produced a directory tree nobody asked for. `portage.rs` makes
           the same call. */
        std::fs::write(&target, text.as_bytes())
            .map_err(|e| format!("could not write {}: {e}", target.display()))?;
        Ok(Saved {
            signins: wrote,
            missing,
        })
    })
    .await?
}

/// A document read back, with every credential taken out of it.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Loaded {
    /// The document as text with every `signIn` removed, so
    /// `accounts.ts::importAccounts` reads it exactly as it reads a pasted one.
    /// One reader for both carriers, rather than a second path through the same
    /// format that can drift away from the tested one.
    pub text: String,
    /// What was taken out, one per credential, in document order.
    pub signins: Vec<Summary>,
}

/// Read an accounts document, park its credentials, and hand back everything
/// about it that is safe to hold in a webview.
///
/// A second load clears the first rather than adding to it. A document opened,
/// looked at and abandoned must not leave credentials behind that a later and
/// unrelated press could install — the parked set is always exactly what the
/// file now on screen contained.
#[tauri::command]
pub async fn load_accounts_file(
    carried: State<'_, Carried>,
    path: String,
) -> Result<Loaded, String> {
    let source = checked_doc(&path)?;
    let (text, sums, creds) = crate::off_main(move || {
        let size = std::fs::metadata(&source)
            .map_err(|e| format!("could not read {}: {e}", source.display()))?
            .len();
        if size > DOC_CEILING {
            return Err(format!(
                "{} is {size} bytes, which is far larger than any accounts document",
                source.display()
            ));
        }
        let text = std::fs::read_to_string(&source)
            .map_err(|e| format!("could not read {}: {e}", source.display()))?;
        let mut doc: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| format!("{} is not JSON: {e}", source.display()))?;

        let mut sums: Vec<Summary> = Vec::new();
        let mut creds: Vec<(String, serde_json::Value)> = Vec::new();
        if let Some(rows) = doc.get_mut("accounts").and_then(|v| v.as_array_mut()) {
            for row in rows.iter_mut() {
                let Some(obj) = row.as_object_mut() else { continue };
                let label = obj
                    .get("label")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                /* Taken out whatever the label looks like, and only *kept* if
                   the label is usable. A document with a malformed row still
                   gets its credential stripped from the text the webview is
                   handed — which is the guarantee this function makes, and it
                   must not depend on the row being good. */
                let Some(cred) = obj.remove("signIn") else { continue };
                if label.is_empty() || !is_label(&label) {
                    continue;
                }
                sums.push(summarize(&label, &cred));
                creds.push((label, cred));
            }
        }
        let clean = serde_json::to_string(&doc)
            .map_err(|e| format!("could not read that document: {e}"))?;
        Ok((clean, sums, creds))
    })
    .await??;

    let mut held = carried
        .0
        .lock()
        .map_err(|_| "the carried sign-ins are wedged".to_string())?;
    held.clear();
    for (label, cred) in creds {
        held.insert(label, cred);
    }
    Ok(Loaded {
        text,
        signins: sums,
    })
}

/// Put one parked credential into an account's store.
///
/// `from` is what the document called it and `label` is where it is to land, and
/// they are two arguments because they are genuinely two things: a document's
/// `lyss` may be installed into a row this machine calls `lyss-2`, and the
/// person who decided that is looking at the panel.
///
/// **This overwrites whatever is in that store**, which is the point — the case
/// this exists for is a credential that has gone stale being replaced by a newer
/// copy of itself. Whether a given install is allowed to happen without being
/// asked for is `accounts.ts::planSignins`, and the panel arms the ones that
/// are not.
#[tauri::command]
pub async fn install_signin(
    app: AppHandle,
    carried: State<'_, Carried>,
    label: String,
    from: String,
) -> Result<(), String> {
    /* Both names, because both reach the filesystem: `label` becomes a
       directory and `from` is a key that came out of a file somebody else
       wrote. `store_dir` checks `label` again on its own account; this is the
       earlier and clearer refusal. */
    if !is_label(&label) {
        return Err("that is not a usable account name".into());
    }
    let cred = {
        let held = carried
            .0
            .lock()
            .map_err(|_| "the carried sign-ins are wedged".to_string())?;
        /* Cloned rather than taken, so an install that fails on a permission or
           a full disk can be pressed again. What bounds how long it is held is
           `drop_carried`, not this. */
        held.get(&from)
            .cloned()
            .ok_or_else(|| format!("there is no sign-in for {from} in that document"))?
    };
    let dir = store_dir(&app, &label)?;
    let file = credential_path(&app, &label)?;
    crate::off_main(move || {
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("could not make {}: {e}", dir.display()))?;
        let text = serde_json::to_string(&cred)
            .map_err(|e| format!("could not write that sign-in: {e}"))?;
        std::fs::write(&file, text.as_bytes())
            .map_err(|e| format!("could not write {}: {e}", file.display()))
    })
    .await?
}

/// Forget every parked credential. Called when the accounts panel closes.
#[tauri::command]
pub fn drop_carried(carried: State<'_, Carried>) -> Result<(), String> {
    carried
        .0
        .lock()
        .map_err(|_| "the carried sign-ins are wedged".to_string())?
        .clear();
    Ok(())
}

/// What the credentials already on this machine are worth, for the accounts
/// asked about.
///
/// So the panel can say whether the sign-in in a file is newer than the one it
/// would replace — which is the difference between an update and a downgrade,
/// and the one fact that decides whether an install needs asking about.
/// Accounts with no credential are absent from the answer rather than present
/// and empty: there is nothing to compare against, and `signed_in` already says
/// so from the registry.
#[tauri::command]
pub async fn signin_ages(app: AppHandle, labels: Vec<String>) -> Result<Vec<Summary>, String> {
    crate::off_main(move || {
        labels
            .into_iter()
            .filter(|l| is_label(l))
            .filter_map(|l| read_credential(&app, &l).map(|c| summarize(&l, &c)))
            .collect::<Vec<Summary>>()
    })
    .await
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

    /* ── carrying the sign-ins ─────────────────────────────────────────── */

    /// The layout's suffix and this one are different on purpose: a document you
    /// can hand somebody and one carrying three live bearer tokens want telling
    /// apart on sight, and the narrow verb is also what keeps this command from
    /// being a way to read or overwrite arbitrary files.
    #[test]
    fn an_accounts_document_is_its_own_kind_of_file() {
        assert!(checked_doc(r"C:\x\mine.volery-accounts.json").is_ok());
        /* A save dialog on Windows will happily give this back capitalised, and
           the filesystem does not care either. */
        assert!(checked_doc(r"C:\x\Mine.Volery-Accounts.JSON").is_ok());
        /* The layout's own suffix is refused — these are not interchangeable
           documents and reading one as the other would report nonsense. */
        assert!(checked_doc(r"C:\x\wall.volery.json").is_err());
        assert!(checked_doc(r"C:\x\anything.json").is_err());
        assert!(checked_doc(r"C:\x\notes.txt").is_err());
        /* Not a full path: a dialog always returns one, so anything else came
           from somewhere that should be saying so. */
        assert!(checked_doc("mine.volery-accounts.json").is_err());
    }

    fn a_credential() -> serde_json::Value {
        serde_json::json!({
            "claudeAiOauth": {
                "accessToken": "sk-ant-oat01-secret",
                "refreshToken": "sk-ant-ort01-secret",
                "expiresAt": 1787432213338i64,
                "refreshTokenExpiresAt": 1789625720339i64,
                "scopes": ["user:inference", "user:profile"],
                "subscriptionType": "team",
                "rateLimitTier": "default_claude_max"
            }
        })
    }

    #[test]
    fn a_summary_says_what_a_sign_in_is_worth() {
        let s = summarize("lyss", &a_credential());
        assert_eq!(s.label, "lyss");
        assert_eq!(s.expires_at, Some(1787432213338));
        assert_eq!(s.refresh_expires_at, Some(1789625720339));
        assert_eq!(s.plan.as_deref(), Some("team"));
    }

    /// **The guarantee of this whole arrangement**, and the assertion to break
    /// if anybody ever widens `Summary` for convenience: what crosses into the
    /// webview carries nothing anybody could spend. The webview is the part of
    /// this app that renders untrusted content, so a token reaching it is one
    /// `console.log` away from leaving the machine a second time.
    #[test]
    fn a_summary_carries_no_token_at_all() {
        let text = serde_json::to_string(&summarize("lyss", &a_credential())).unwrap();
        assert!(!text.contains("sk-ant"));
        assert!(!text.contains("accessToken"));
        assert!(!text.contains("refreshToken"));
        assert!(!text.contains("secret"));
        /* And the refresh *stamp* is there, which is the one field whose name
           looks like the token's and is not it. */
        assert!(text.contains("refreshExpiresAt"));
    }

    /// A file may have been written by an older CLI or a newer one, so a missing
    /// stamp costs the face a sentence and never costs the credential its
    /// installability.
    #[test]
    fn a_credential_with_no_stamps_still_summarises() {
        let s = summarize("odd", &serde_json::json!({ "claudeAiOauth": {} }));
        assert_eq!(s.label, "odd");
        assert_eq!(s.expires_at, None);
        assert_eq!(s.refresh_expires_at, None);
        assert_eq!(s.plan, None);

        /* Nor does a stamp of the wrong type become a zero, which would read as
           1970 and draw "expired 56 years ago". */
        let odd = summarize(
            "odd",
            &serde_json::json!({ "claudeAiOauth": { "expiresAt": "soon" } }),
        );
        assert_eq!(odd.expires_at, None);
    }

    /// A credential handed over already unwrapped summarises rather than coming
    /// back empty — the same degrade-to-something-usable bargain every other
    /// opaque document in this app strikes.
    #[test]
    fn an_unwrapped_credential_summarises_too() {
        let s = summarize(
            "flat",
            &serde_json::json!({ "expiresAt": 12i64, "subscriptionType": "pro" }),
        );
        assert_eq!(s.expires_at, Some(12));
        assert_eq!(s.plan.as_deref(), Some("pro"));
    }
}
