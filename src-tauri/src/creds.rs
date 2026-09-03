//! The credential panel's four commands, for any integration.
//!
//! `vault.rs` decided *where* a secret goes and has been general since Spotify
//! wanted the same treatment — `store_at` / `read_at` / `clear_at` / `held_at`
//! all take a target. What was not general was everything above it: three
//! commands named `*_azdo_token`, one panel worded for Azure DevOps, and a
//! header button that said "azdo token". So a second service (Asana) needed no
//! new credential layer at all; it needed this file, which is the layer that
//! was missing.
//!
//! ## The front end names a service, never a target
//!
//! The obvious shape — commands that take a vault target — is the wrong one,
//! and it is worth saying why rather than only what. A `clear_at(target)` the
//! front end can call with any string is a command that will delete *any*
//! Windows credential on the machine, Git Credential Manager's included. A
//! prefix guard (`dev.skein.studio/…`) would bound that, and it would still be
//! a guard rather than an impossibility.
//!
//! So the wire vocabulary is a **service id** — `"azdo"`, `"asana"` — and this
//! file is the only place that maps one to a target. An id nothing here answers
//! for is refused by name. `src/lib/integrations.ts` quotes the target strings
//! so the panel can *show* you where your token is (which is the whole argument
//! for using Credential Manager instead of a blob of our own), and
//! `test/integrations.test.ts` holds the two files against each other, because
//! a target that drifts is a credential that silently disappears: still on
//! disk, under a name nothing looks up any more.
//!
//! **`dev.skein.studio/azdo-pat` is not renameable.** It is `vault.rs`'s
//! constant, quoted here rather than re-spelled, and the reasoning is the same
//! one `identifier: "dev.skein.studio"` gets a section of CLAUDE.md for: the
//! vault keys off the durable identity, so a visible rename cannot make the app
//! read as having forgotten a credential you can still see in Control Panel.
//!
//! ## Verifying is the part that earns its keep
//!
//! A stored token that is *wrong* is indistinguishable from a missing one until
//! something fails hours later, in a widget, in a voice that names the network
//! rather than the credential. Each service therefore brings one cheap
//! authenticated GET, run when you ask for it and never on a timer — this is a
//! panel you opened, so the standing rule that a poller must be bounded by
//! somebody watching is satisfied by there being no poller.
//!
//! The probe is the *scope that matters*, not merely a live token, and for
//! Azure DevOps that distinction decides the endpoint. `profiles/me` would
//! answer for any PAT with `vso.profile` on it and 401 for a token scoped to
//! **Build (read)** alone — which is precisely the token the panel exists to
//! take, so the check would fail the one credential it was written for. It asks
//! about builds in an organisation on this wall instead, and where there is no
//! such organisation it says so rather than guessing.

use serde::Serialize;
use tauri::AppHandle;

/// One service the panel can hold a token for.
///
/// A const slice of these rather than a match on the id in four commands: the
/// third integration should be one entry, and a `match` in each command is four
/// places to forget. Same bargain `widgets.ts`'s catalogue strikes on the other
/// side of the wire.
struct Service {
    /// What the wire calls it. Must match an `id` in `src/lib/integrations.ts`.
    id: &'static str,
    /// Where its token lives. The authority for this string, except azdo's,
    /// which is `vault.rs`'s because the credential ladder reads it with no
    /// front end involved.
    target: &'static str,
    /// What the vault entry says it is for, to somebody reading Credential
    /// Manager rather than this file.
    who: &'static str,
    /// One cheap authenticated GET. `Ok` carries what to call the identity it
    /// resolved to; `Err` carries the service's own words.
    ///
    /// The second argument is the wall's project roots — the same context
    /// `azdo_runs` already takes. Asana ignores it; Azure DevOps cannot, since
    /// every endpoint worth asking about is under an organisation.
    probe: fn(&str, &[String]) -> Result<String, String>,
    /// What to let go of when this service's token is replaced or removed.
    ///
    /// Azure DevOps resolves its credential ladder once per organisation and
    /// holds it, so without this the token you just pasted would not be
    /// consulted until the last widget came off the wall — the bug
    /// `release_azdo` exists for, arriving through a different door.
    forget: fn(&AppHandle),
}

/// Asana's entry. Declared here rather than in `asana.rs` because this file is
/// the registry and a second copy is the drift the whole arrangement is
/// avoiding; `asana.rs` reads it back through `token`.
const ASANA_TARGET: &str = "dev.skein.studio/asana-pat";
const ASANA_WHO: &str = "asana (volery)";

const SERVICES: &[Service] = &[
    Service {
        id: "azdo",
        target: crate::vault::AZDO_TARGET,
        who: crate::vault::AZDO_WHO,
        probe: probe_azdo,
        forget: forget_forges,
    },
    Service {
        id: "asana",
        target: ASANA_TARGET,
        who: ASANA_WHO,
        probe: probe_asana,
        /* Nothing to drop: the Asana reading holds no credential cache in Rust
           — every request reads the vault, which costs a syscall and means a
           token deleted in Control Panel stops working immediately rather than
           at the next detach. */
        forget: forget_nothing,
    },
];

fn lookup(id: &str) -> Result<&'static Service, String> {
    SERVICES
        .iter()
        .find(|s| s.id == id)
        .ok_or_else(|| format!("no integration called {id}"))
}

/// A stored token, for the module that needs one.
///
/// The one read path out of this file, and it hands back the secret — which
/// everything else here is arranged not to do. The line is between Rust and the
/// front end rather than between modules: an `Authorization` header needs the
/// token and a panel does not, so `integration_held` is a boolean and there is
/// no command that returns one.
///
/// `asana.rs` is the caller, per request rather than cached — a syscall, and it
/// buys the property `vault.rs` chose Credential Manager for: a token deleted
/// in Control Panel stops working immediately rather than at the next detach.
pub fn token(id: &str) -> Option<String> {
    crate::vault::read_at(lookup(id).ok()?.target)
}

/* ── the four commands ─────────────────────────────────────────────────────*/

/// Whether a token is stored. Never the token.
///
/// Asked rather than remembered, because Credential Manager is reachable
/// without us — the whole point of putting it there — so a cached answer can be
/// stale in the one direction that matters.
#[tauri::command]
pub async fn integration_held(service: String) -> Result<bool, String> {
    let s = lookup(&service)?;
    crate::off_main(move || crate::vault::held_at(s.target)).await
}

/// Store one, replacing whatever was there.
#[tauri::command]
pub async fn set_integration_token(
    app: AppHandle,
    service: String,
    token: String,
) -> Result<(), String> {
    let s = lookup(&service)?;
    /* Off the main thread for the reason `release_azdo` is, and it is not the
       vault: `forget` takes a mutex that a reading pass holds for an entire
       network round, so left here it would wait on the main thread and freeze
       every card on the wall for as long as the poll takes. */
    crate::off_main(move || {
        crate::vault::store_at(s.target, s.who, &token)?;
        (s.forget)(&app);
        Ok(())
    })
    .await?
}

#[tauri::command]
pub async fn clear_integration_token(app: AppHandle, service: String) -> Result<(), String> {
    let s = lookup(&service)?;
    crate::off_main(move || {
        crate::vault::clear_at(s.target)?;
        (s.forget)(&app);
        Ok(())
    })
    .await?
}

/// What one authenticated request said about the stored token.
///
/// Answered as a value rather than as an `Err` for a refusal, because "the
/// service said no" and "the command could not run" are different facts and the
/// panel draws them differently. `Err` is kept for the second: an unknown
/// service id, which is a bug in the caller.
#[derive(Serialize)]
pub struct Verdict {
    pub ok: bool,
    /// What the service said the token belongs to. Empty where it would not
    /// say. Naming the identity is the useful half — a token minted as the
    /// wrong account is accepted and then sees none of your projects, which
    /// reads as an empty widget rather than as an error.
    pub who: String,
    /// The service's own words when it refused, quoted rather than reworded.
    pub said: String,
}

#[tauri::command]
pub async fn verify_integration(service: String, roots: Vec<String>) -> Result<Verdict, String> {
    let s = lookup(&service)?;
    crate::off_main(move || {
        let Some(token) = crate::vault::read_at(s.target) else {
            /* Not a fault of the token's, and the panel knows this state
               already from `held` — but a verify that answered "refused" for an
               empty vault would be the app blaming a credential that is not
               there. */
            return Verdict { ok: false, who: String::new(), said: "nothing stored".into() };
        };
        match (s.probe)(&token, &roots) {
            Ok(who) => Verdict { ok: true, who, said: String::new() },
            Err(said) => Verdict { ok: false, who: String::new(), said },
        }
    })
    .await
}

/* ── letting go ────────────────────────────────────────────────────────────*/

/// Both forges, for the reason `release_azdo` drops both: the front end has one
/// connection to them and a credential change is a change to the whole of it.
fn forget_forges(app: &AppHandle) {
    crate::azdo::forget_creds(app);
}

fn forget_nothing(_app: &AppHandle) {}

/* ── the probes ────────────────────────────────────────────────────────────*/

/// Azure DevOps: can this token read builds in an organisation on this wall?
///
/// **Not `profiles/me`**, which is the obvious org-less check and is the wrong
/// one — see the module header. A PAT scoped to Build (read) alone has no
/// `vso.profile`, so the tidy endpoint would refuse exactly the token this
/// panel was written to take, and report it as a bad credential.
///
/// One organisation is enough. The ladder resolves per organisation, so a token
/// accepted by one and refused by another is an ordinary thing rather than a
/// contradiction, and a check that walked every org on the wall would be a
/// check that costs a request per project to say something no shorter.
fn probe_azdo(token: &str, roots: &[String]) -> Result<String, String> {
    let org = azdo_org(roots).ok_or_else(|| {
        "no azure devops organisation on this wall to check it against — open a folder cloned \
         from one"
            .to_string()
    })?;
    /* `$top=1` because the answer is the status code. A build list is the
       cheapest thing in the scope that matters, and one row of it is as
       conclusive as a thousand. */
    let url =
        format!("https://dev.azure.com/{org}/_apis/build/builds?api-version=7.1&$top=1");
    let header = format!("Basic {}", crate::base64(format!(":{token}").as_bytes()));
    let res = crate::forge::agent()
        .get(&url)
        .set("Authorization", &header)
        .set("Accept", "application/json")
        .call();
    match res {
        Ok(_) => Ok(format!("reads builds in {org}")),
        /* 203 is not in this arm because Azure DevOps does not use it here; a
           401 or 403 is the token being insufficient, and both are worth
           reporting in the service's own numbers rather than reworded, since
           the difference between them is the difference between a scope and an
           identity. */
        Err(ureq::Error::Status(code, res)) => Err(format!(
            "azure devops answered {code}{}",
            trailing(res.into_string().unwrap_or_default())
        )),
        Err(e) => Err(format!("could not reach azure devops: {e}")),
    }
}

/// The first Azure DevOps organisation any project on this wall is cloned from.
///
/// `forge::remote_of` rather than a `git` of its own, which is the reader that
/// sets `GIT_TERMINAL_PROMPT=0` — this is not a background poll, but a
/// credential window opening over the wall while you are checking a token would
/// be an especially poor moment for it.
fn azdo_org(roots: &[String]) -> Option<String> {
    for root in roots {
        if let Some(org) = crate::forge::remote_of(root).as_deref().and_then(crate::azdo::org_of) {
            return Some(org);
        }
    }
    None
}

/// Asana: whose token is this?
///
/// `GET /users/me` is the documented cheapest authenticated call and it answers
/// with the identity, which makes it both halves of the check at once — a token
/// that works, and the account it works as. Asana PATs are not scoped, so
/// unlike Azure DevOps there is no narrower permission this could be right
/// about and wrong about.
fn probe_asana(token: &str, _roots: &[String]) -> Result<String, String> {
    let res = crate::forge::agent()
        .get("https://app.asana.com/api/1.0/users/me")
        .set("Authorization", &format!("Bearer {token}"))
        .set("Accept", "application/json")
        .call();
    match res {
        Ok(res) => {
            let v: serde_json::Value = res
                .into_json()
                .map_err(|e| format!("unreadable answer from asana: {e}"))?;
            let data = v.get("data").unwrap_or(&serde_json::Value::Null);
            let name = crate::forge::text(data, "name");
            let email = crate::forge::text(data, "email");
            /* The email when there is one, because two people on a workspace
               can share a display name and the point of naming the identity is
               to catch a token minted as the wrong one. */
            Ok(match (name.is_empty(), email.is_empty()) {
                (false, false) => format!("{name} <{email}>"),
                (false, true) => name,
                (true, false) => email,
                (true, true) => String::new(),
            })
        }
        Err(ureq::Error::Status(code, res)) => Err(format!(
            "asana answered {code}{}",
            trailing(res.into_string().unwrap_or_default())
        )),
        Err(e) => Err(format!("could not reach asana: {e}")),
    }
}

/// The useful part of an error body, as a suffix or as nothing.
///
/// Both services answer a refusal with JSON — Azure DevOps a `{"message": …}`,
/// Asana an `{"errors": [{"message": …}]}` — and both also answer with an HTML
/// sign-in page under a proxy, which is a thousand characters of nothing. So
/// this reads the two shapes it knows and gives up quietly otherwise: a status
/// code alone is a short true sentence, and a page of markup beside it is not a
/// longer one.
fn trailing(body: String) -> String {
    let said = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| {
            v.get("message")
                .or_else(|| v.pointer("/errors/0/message"))
                .and_then(|m| m.as_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_default();
    let said = said.lines().next().unwrap_or("").trim().to_string();
    if said.is_empty() {
        String::new()
    } else {
        format!(": {said}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_service_answers_to_its_own_id() {
        for s in SERVICES {
            assert_eq!(lookup(s.id).unwrap().target, s.target);
        }
    }

    #[test]
    fn an_unknown_service_is_refused_by_name() {
        /* By name rather than as a bare failure: this is reachable only from
           our own front end, so an error here is a typo in a component and the
           id is the whole of what is worth saying. */
        let err = lookup("bitbucket").err().unwrap();
        assert!(err.contains("bitbucket"), "{err}");
    }

    #[test]
    fn azure_devops_still_points_at_the_target_it_always_did() {
        /* The one string in this file that is not ours to change. The user's
           real PAT is under this name; renaming it does not migrate the
           credential, it orphans it. */
        assert_eq!(lookup("azdo").unwrap().target, "dev.skein.studio/azdo-pat");
    }

    #[test]
    fn every_target_sits_under_the_durable_identity() {
        for s in SERVICES {
            assert!(
                s.target.starts_with("dev.skein.studio/"),
                "{} wandered out of the namespace: {}",
                s.id,
                s.target
            );
        }
    }

    #[test]
    fn no_two_services_share_a_target() {
        /* Two ids on one vault entry is a panel where storing one token removes
           another, and the receipt for both would say it worked. */
        for (i, a) in SERVICES.iter().enumerate() {
            for b in SERVICES.iter().skip(i + 1) {
                assert_ne!(a.target, b.target, "{} and {} share an entry", a.id, b.id);
            }
        }
    }

    #[test]
    fn an_error_body_is_read_for_its_one_sentence() {
        assert_eq!(
            trailing(r#"{"message":"TF400813: not authorized"}"#.into()),
            ": TF400813: not authorized"
        );
        assert_eq!(
            trailing(r#"{"errors":[{"message":"Not Authorized"}]}"#.into()),
            ": Not Authorized"
        );
    }

    #[test]
    fn a_page_of_markup_is_not_a_longer_sentence() {
        /* What a TLS-intercepting proxy answers with when it wants a sign-in.
           The status code alone is the honest reading. */
        assert_eq!(trailing("<!DOCTYPE html><html><body>Sign in".into()), "");
        assert_eq!(trailing(String::new()), "");
    }
}
