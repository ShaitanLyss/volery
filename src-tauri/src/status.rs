//! Whether Claude itself is up, off `status.claude.com`.
//!
//! One question, asked over HTTP, answered in facts. Everything that is a
//! *judgement* about those facts — which indicator is worse than which, what to
//! call any of it, which component to draw first when the box only fits three,
//! how stale a reading has to be before it stops being a reading — is in
//! `status.ts` and tested there. That is the split `limits.rs` draws against
//! `limits.ts` and `update.rs` against `update.ts`, and it is drawn here for
//! their reason: the part that will be argued about is the policy, and an
//! argument is worth having against tests.
//!
//! ### What was probed, and what it answered
//!
//! `status.claude.com` is a Statuspage instance (page id `tymt9n04zgry`), which
//! means the documented `/api/v2/*` surface. Probed 2026-08-27 with `curl`:
//!
//! - **`/api/v2/status.json`** — 210 bytes. `page` (id, name, url, time_zone,
//!   updated_at) and `status` (`indicator`, `description`). Returned
//!   `{"indicator":"none","description":"All Systems Operational"}`. The whole
//!   headline and nothing else: no components, so a widget drawn from this alone
//!   could never say *which* thing is degraded.
//! - **`/api/v2/summary.json`** — ~2.2 KB on a quiet day. Everything
//!   `status.json` has, plus `components` (six of them: claude.ai, Claude
//!   Console, Claude API, Claude Code, Claude Cowork, Claude for Government —
//!   each with `status`, `position`, `group`, `only_show_if_degraded`), plus
//!   `incidents` and `scheduled_maintenances`, both **unresolved only**. Both
//!   were `[]` at probe time.
//! - **`/api/v2/incidents.json`** — the last 50, resolved included, for shape.
//!   Across those 50 the distinct `impact` values were exactly
//!   `none | minor | major | critical`, and the distinct `incident_updates[].status`
//!   values exactly `investigating | identified | monitoring | resolved`. An
//!   incident carries `name`, `status`, `impact`, `shortlink`
//!   (`https://stspg.io/…`), `started_at`, and `incident_updates` newest-first,
//!   each with a `body`, a `display_at`, and the components it moved with their
//!   `old_status`/`new_status`.
//!
//! So this asks `summary.json` and nothing else. It is the only one of the three
//! that can answer both halves of the question a person actually has — "is it
//! them?" and "is it the part I am using?" — and 2 KB against 210 bytes is not a
//! difference anything on this wall can feel.
//!
//! No probe example beside `limits-probe` and `find-probe`, and that is a
//! judgement rather than an omission: those two exist because their endpoints
//! are undocumented and move (`/api/oauth/usage`) or because the *cost* is the
//! unknown (ripgrep over a tree). This is a published, versioned, stable API
//! with a schema Statuspage documents, and the paragraph above is the finding.
//!
//! ### What was rejected
//!
//! The page's own "subscribe to updates" offers email, Slack, Atom/RSS and
//! webhooks. None of them is a way for *this process* to be told:
//!
//! - **Webhook** — needs an inbound URL. A desktop app behind NAT has none, and
//!   giving it one means a public listener and a hosted relay to forward
//!   through: a service to stand up and keep alive, so that a 2 KB GET can be
//!   avoided. That is the whole of the rejection.
//! - **Email and Slack** — they arrive in a person's inbox, not in a process.
//!   Nothing here can read either without holding a credential for something
//!   that has nothing to do with this app.
//! - **Atom/RSS (`/history.atom`)** — still a poll, with a *worse* answer. It is
//!   a feed of incident *history*: bigger on the wire, resolved entries mixed in,
//!   and — decisively — silent about the current indicator when nothing has
//!   happened lately, which is the state the widget is in almost all the time.
//!   Polling a feed to find out that nothing is wrong is polling for less.
//!
//! Which leaves going and looking, and the argument for the cadence is not here.
//! It is in `beacon.svelte.ts` and written out in `.claude/rules/widgets.md`,
//! because it is a decision about the *wall* rather than about HTTP.

use serde::Serialize;

/// How long to wait on the status page before giving up.
///
/// Short, and shorter than `update.rs`'s ten seconds, because the failure is
/// cheap in both directions: nothing depends on this answer, and the face has a
/// reading to draw either way ("could not ask" is itself news when you are
/// trying to find out whether the network is the problem). A long wait would
/// only make a bad network slower at telling you it is bad.
const ASK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

const SUMMARY: &str = "https://status.claude.com/api/v2/summary.json";

/// One service on the page.
///
/// `group` and `only_show_if_degraded` are carried rather than acted on: a group
/// row is a heading and not a service, and a component marked
/// `only_show_if_degraded` is one the page hides while it is fine — both are
/// decisions about what to *draw*, which is `status.ts`'s half of the bargain.
/// Claude's page has no groups today and nothing hidden; passing the flags means
/// the day it does costs no Rust.
#[derive(Debug, Clone, Serialize)]
pub struct Part {
    pub name: String,
    /// `operational | degraded_performance | partial_outage | major_outage |
    /// under_maintenance`, verbatim. Never narrowed here — a value Statuspage
    /// adds tomorrow reaches the front end intact and degrades there.
    pub status: String,
    /// The page's own ordering, which is a thing the page decided and this is
    /// not entitled to re-decide.
    pub position: i64,
    pub group: bool,
    pub hidden_when_well: bool,
}

/// One note posted against an incident. Newest first, as Statuspage sends them.
#[derive(Debug, Clone, Serialize)]
pub struct Note {
    /// `investigating | identified | monitoring | resolved`.
    pub status: String,
    pub body: String,
    /// `display_at` — what the page shows, which is not always `created_at`.
    pub at: String,
}

/// An unresolved incident, or a scheduled maintenance, which Statuspage models
/// as the same thing with a different list to sit in.
#[derive(Debug, Clone, Serialize)]
pub struct Incident {
    pub id: String,
    pub name: String,
    pub status: String,
    /// `none | minor | major | critical`.
    pub impact: String,
    /// `https://stspg.io/…`, which is where the button goes. Out of the app
    /// through `onopen`, never an `<a href>` — see `open.rs`.
    pub url: String,
    pub started_at: String,
    /// Every note, newest first. Picking the one to draw is a judgement and
    /// belongs upstairs; there are rarely more than four, so sending them all
    /// costs nothing and lets the face open one out.
    pub notes: Vec<Note>,
    /// The components this incident says it is affecting, by name — taken from
    /// the newest note that named any. Names rather than ids because that is
    /// what the components list is matched on up there, and Statuspage spells
    /// them identically in both places.
    pub affects: Vec<String>,
}

/// One read of the status page.
#[derive(Debug, Clone, Serialize)]
pub struct Health {
    /// `none | minor | major | critical | maintenance`, verbatim.
    pub indicator: String,
    /// The page's own sentence — "All Systems Operational". Drawn as written:
    /// this app does not get to paraphrase somebody else's status page.
    pub description: String,
    /// `page.updated_at`, ISO 8601. Not the same thing as when *we* asked, which
    /// is why the front end stamps its own — see `beacon.svelte.ts`. A page that
    /// has not been touched for a week is normal; a *reading* a week old is not.
    pub updated_at: String,
    pub components: Vec<Part>,
    pub incidents: Vec<Incident>,
    pub maintenances: Vec<Incident>,
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(ASK_TIMEOUT)
        .timeout_read(ASK_TIMEOUT)
        .build()
}

fn text(v: &serde_json::Value, key: &str) -> String {
    v[key].as_str().unwrap_or_default().to_string()
}

fn notes_of(v: &serde_json::Value) -> Vec<Note> {
    v["incident_updates"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|u| Note {
                    status: text(u, "status"),
                    body: text(u, "body"),
                    at: text(u, "display_at"),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The components the newest note that named any says are affected.
///
/// The newest rather than the union of all of them, and it matters: a resolving
/// incident's last note lists the components going *back* to operational, and a
/// union would keep claiming a service was affected after the page had said it
/// was not. Statuspage's own page reads the same way.
fn affects_of(v: &serde_json::Value) -> Vec<String> {
    v["incident_updates"]
        .as_array()
        .and_then(|a| {
            a.iter().find_map(|u| {
                let comps = u["affected_components"].as_array()?;
                let names: Vec<String> = comps
                    .iter()
                    .filter_map(|c| Some(c["name"].as_str()?.to_string()))
                    .collect();
                (!names.is_empty()).then_some(names)
            })
        })
        .unwrap_or_default()
}

fn incidents_in(body: &serde_json::Value, key: &str) -> Vec<Incident> {
    body[key]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|it| Incident {
                    id: text(it, "id"),
                    name: text(it, "name"),
                    status: text(it, "status"),
                    impact: text(it, "impact"),
                    url: text(it, "shortlink"),
                    started_at: text(it, "started_at"),
                    notes: notes_of(it),
                    affects: affects_of(it),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Ask the status page how Claude is.
///
/// `async`, and that is load-bearing rather than stylistic: it is a network
/// request with a read timeout, and a `#[tauri::command]` without `async` runs
/// inline on the thread that drains the event loop — so a synchronous version
/// would stop every card on the wall from being painted for the length of every
/// ask. That is the `azdo_runs` freeze, and CLAUDE.md's paragraph on `off_main`
/// is the whole of it.
///
/// Unauthenticated, and it stays that way. These endpoints are public, static,
/// CDN-fronted and hold nothing about this machine; a status check that wanted a
/// credential would be a status check nobody could audit. Nothing about this
/// request identifies the wall beyond a user agent naming the app, which is the
/// courtesy `update.rs` already extends to GitHub for its own reason.
///
/// Every failure is an `Err` carrying a sentence, and the front end *draws* it —
/// which is the deliberate opposite of `latest_release`, where a failure is
/// silence in the header. An update nobody could check for is a fact about
/// plumbing; a status page nobody could reach is a reading, because it is
/// evidence about exactly the thing you opened the widget to ask about.
#[tauri::command]
pub async fn claude_status() -> Result<Health, String> {
    crate::off_main(|| {
        let res = agent()
            .get(SUMMARY)
            .set("User-Agent", concat!("volery/", env!("CARGO_PKG_VERSION")))
            .set("Accept", "application/json")
            .call()
            .map_err(|e| format!("could not reach status.claude.com: {e}"))?;
        let body: serde_json::Value = res
            .into_json()
            .map_err(|e| format!("the status page's answer was not readable: {e}"))?;

        let components = body["components"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|c| {
                        Some(Part {
                            name: c["name"].as_str()?.to_string(),
                            status: text(c, "status"),
                            position: c["position"].as_i64().unwrap_or(0),
                            group: c["group"].as_bool().unwrap_or(false),
                            hidden_when_well: c["only_show_if_degraded"]
                                .as_bool()
                                .unwrap_or(false),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        Ok(Health {
            indicator: text(&body["status"], "indicator"),
            description: text(&body["status"], "description"),
            updated_at: text(&body["page"], "updated_at"),
            components,
            incidents: incidents_in(&body, "incidents"),
            maintenances: incidents_in(&body, "scheduled_maintenances"),
        })
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The one shaped answer probed on 2026-08-24, trimmed to the fields this
    /// file reads. Kept because the resolving-incident case is the only piece of
    /// arithmetic in here, and it is the piece a union would get wrong.
    const RESOLVING: &str = r#"{
      "page": {"id": "tymt9n04zgry", "updated_at": "2026-08-27T02:34:03.699Z"},
      "status": {"indicator": "minor", "description": "Partially Degraded Service"},
      "components": [
        {"id": "a", "name": "claude.ai", "status": "operational", "position": 1,
         "group": false, "only_show_if_degraded": false},
        {"id": "b", "name": "Claude Code", "status": "degraded_performance", "position": 4,
         "group": false, "only_show_if_degraded": true}
      ],
      "incidents": [
        {"id": "n0", "name": "Issues logging into Claude.ai", "status": "monitoring",
         "impact": "minor", "shortlink": "https://stspg.io/6211zbpptv0y",
         "started_at": "2026-08-24T20:11:23.924Z",
         "incident_updates": [
           {"status": "monitoring", "body": "Monitoring closely.",
            "display_at": "2026-08-24T20:26:21.577Z",
            "affected_components": [{"code": "a", "name": "claude.ai"}]},
           {"status": "investigating", "body": "Looking into it.",
            "display_at": "2026-08-24T20:11:24.058Z",
            "affected_components": [
              {"code": "a", "name": "claude.ai"},
              {"code": "b", "name": "Claude Code"},
              {"code": "c", "name": "Claude Cowork"}
            ]}
         ]}
      ],
      "scheduled_maintenances": []
    }"#;

    fn parsed() -> serde_json::Value {
        serde_json::from_str(RESOLVING).expect("the probed shape parses")
    }

    #[test]
    fn the_flags_a_component_carries_survive() {
        let body = parsed();
        let c = &body["components"][1];
        assert_eq!(c["name"].as_str(), Some("Claude Code"));
        assert!(c["only_show_if_degraded"].as_bool().unwrap());
        assert_eq!(c["position"].as_i64(), Some(4));
    }

    #[test]
    fn notes_arrive_newest_first_and_whole() {
        let body = parsed();
        let notes = notes_of(&body["incidents"][0]);
        assert_eq!(notes.len(), 2);
        assert_eq!(notes[0].status, "monitoring");
        assert_eq!(notes[0].at, "2026-08-24T20:26:21.577Z");
        assert_eq!(notes[1].status, "investigating");
    }

    /// The one thing in this file that could be wrong quietly. An incident on
    /// its way out names fewer components in its newest note than in its first;
    /// a union of every note would keep claiming Claude Code was affected long
    /// after the page had stopped saying so.
    #[test]
    fn affected_is_the_newest_note_and_not_the_union() {
        let body = parsed();
        assert_eq!(affects_of(&body["incidents"][0]), vec!["claude.ai"]);
    }

    /// A note with no components at all is skipped rather than taken as an
    /// answer of "nothing" — Statuspage posts plenty of prose-only updates, and
    /// the newest of those must not blank the affected list.
    #[test]
    fn a_prose_only_note_does_not_blank_the_list() {
        let one: serde_json::Value = serde_json::from_str(
            r#"{"incident_updates": [
                 {"status": "monitoring", "body": "Still watching.",
                  "display_at": "t2", "affected_components": []},
                 {"status": "investigating", "body": "Found it.",
                  "display_at": "t1",
                  "affected_components": [{"code": "b", "name": "Claude Code"}]}
               ]}"#,
        )
        .unwrap();
        assert_eq!(affects_of(&one), vec!["Claude Code"]);
    }

    #[test]
    fn an_incident_with_no_updates_at_all_is_not_a_panic() {
        let none: serde_json::Value = serde_json::from_str(r#"{"id": "x"}"#).unwrap();
        assert!(notes_of(&none).is_empty());
        assert!(affects_of(&none).is_empty());
    }

    #[test]
    fn the_quiet_day_shape_reads_as_quiet() {
        let quiet: serde_json::Value = serde_json::from_str(
            r#"{"page": {"updated_at": "t"},
                "status": {"indicator": "none", "description": "All Systems Operational"},
                "components": [], "incidents": [], "scheduled_maintenances": []}"#,
        )
        .unwrap();
        assert!(incidents_in(&quiet, "incidents").is_empty());
        assert!(incidents_in(&quiet, "scheduled_maintenances").is_empty());
        assert_eq!(text(&quiet["status"], "indicator"), "none");
    }
}
