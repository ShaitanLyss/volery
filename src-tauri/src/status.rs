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
    crate::off_main(read).await?
}

/// One read of the page, blocking.
///
/// Split out of the command above so the MCP tool can call it without an
/// `off_main`: `ask::start` gives every MCP request a thread of its own — the
/// parked question needed it — so the network call there is nobody's main
/// thread. The command keeps its `off_main` for the reason stated above it.
pub fn read() -> Result<Health, String> {
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
                        hidden_when_well: c["only_show_if_degraded"].as_bool().unwrap_or(false),
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
}

/* ── the tool a card can call ──────────────────────────────────────────── */

/// A card calls this as `mcp__skein__claude_status`.
pub const STATUS_TOOL: &str = "claude_status";

/// Why a card can ask this at all, when the widget above already answers it for
/// a person.
///
/// The widget's whole argument is "is it me or is it them?", and an agent has
/// exactly that question with none of the ways to answer it. A card whose turn
/// just died sees one line — `API Error: 500 Internal server error` — and its
/// two available conclusions are *retry blindly* and *my code is wrong*, both
/// expensive when the truth is a third thing. That happened on this wall while
/// this was being written: card 580c7a55 was opened to run an audit, died on a
/// 500 before it read a single file, and neither it nor the card that opened it
/// could tell an outage from a bug.
///
/// **Deferred rather than `alwaysLoad`, and that is a real decision rather than
/// a default.** The loaded tier's rule is "named by `append_prompt`" or
/// "reflex-shaped, where not looking is the failure", and a case can be made
/// that this is the second — the default on a 500 genuinely is to blame
/// yourself. What settles it the other way is the cost: every description in
/// that tier is in front of every agent on every turn of every card, and this
/// question arises rarely and *always with an error message attached*, which is
/// itself a strong prompt to go looking. The hint carries the words that error
/// message contains, so an agent searching at the moment it wants this finds
/// it. If it turns out nobody does, promoting it is one word — and that should
/// be decided on evidence rather than here.
pub fn status_schema() -> serde_json::Value {
    serde_json::json!({
        "name": STATUS_TOOL,
        "description":
            "Whether Claude itself is up, read from status.claude.com. Call it when a \
             turn, a tool or a subagent has just failed in a way that might not be \
             your fault — a 500, an overloaded error, a request that timed out — \
             **before** concluding the bug is in the code you are working on and \
             starting to change it.\n\n\
             What comes back is the page's own reading: the overall indicator, its \
             own sentence for it, any component that is not operational, and any \
             open incident with its newest update. Costs nothing and takes no other \
             conversation's time.\n\n\
             **A green page is not a promise about your request.** It means no \
             widespread incident is being reported, which leaves both a transient \
             error and a bug in your own work entirely possible — so read green as \
             'stop blaming the API', not as 'retry until it works'. Do not poll it: \
             an outage that has just begun and one about to end look identical a \
             second apart, and nothing you learn by asking twice in a minute changes \
             what you should do.",
        "inputSchema": { "type": "object", "properties": {} }
    })
}

/// Route a `tools/call` that belongs to this file. `None` for a name it does not
/// claim, so `ask.rs` can go on asking.
///
/// Blocking, on the MCP request's own thread — `ask::start` gives every request
/// one, so the network call here is nobody's main thread and wants no
/// `off_main`. The `#[tauri::command]` above needs its own for the reason
/// stated there.
pub fn handle(tool: &str, _args: &serde_json::Value) -> Option<String> {
    (tool == STATUS_TOOL).then(|| match read() {
        Ok(h) => say(&h),
        /* A page nobody could reach is **evidence**, not a failure to report,
           and this is the same call the widget makes: an update check that
           cannot run is a fact about plumbing, where a status page that cannot
           be reached is a fact about the very thing being asked after. So it is
           said plainly and pointed at the reading it does support — a machine
           that cannot reach a public CDN is one whose API calls were probably
           failing for the same reason. */
        Err(e) => format!(
            "Could not reach status.claude.com — {e}\n\n\
             That is itself worth something. This page is CDN-hosted and answers \
             from almost anywhere, so a machine that cannot reach it usually \
             cannot reach the API either: read it as a network problem at this \
             end rather than as no news."
        ),
    })
}

/// Fold a reading into the answer to "is it them?".
///
/// Prose rather than JSON, because every other tool on this server answers in
/// prose and because what is wanted is a *judgement* — an agent handed a
/// components array has to do this fold itself, and would do it differently
/// every time.
///
/// The page's own sentence is quoted verbatim and never paraphrased. That is
/// this file's standing rule for the widget and it binds harder here: an agent
/// is likelier than a person to repeat what it is told as fact, so what it
/// repeats had better be what the page actually said.
pub fn say(h: &Health) -> String {
    /* The indicator leads, but a component can drag it down. The page is
       entitled to call one degraded component a `minor`, and has been observed
       saying `none` while a component says it is down — so reporting "all
       operational" over a component that is not would be the one dishonest
       thing this could do. Group rows are dropped: a heading is not a service. */
    let ill: Vec<&Part> = h
        .components
        .iter()
        .filter(|c| !c.group && c.status != "operational")
        .collect();

    let calm = h.indicator == "none" && ill.is_empty() && h.incidents.is_empty();
    let mut out = String::new();

    if calm {
        out.push_str(&format!(
            "Claude looks up. status.claude.com says \"{}\" and reports no open \
             incidents.\n\nSo whatever just failed is not a reported outage. It may \
             still be transient — those happen without ever reaching the status page \
             — or it may be your own code. Retrying once is reasonable; retrying in \
             a loop is not.",
            h.description
        ));
    } else {
        out.push_str(&format!(
            "Claude is NOT fully up. status.claude.com says \"{}\" (indicator: {}).",
            h.description, h.indicator
        ));
        if !ill.is_empty() {
            out.push_str("\n\nNot operational:");
            for c in &ill {
                out.push_str(&format!("\n  - {} — {}", c.name, c.status));
            }
        }
        for inc in &h.incidents {
            out.push_str(&format!(
                "\n\nIncident: {} ({}, impact {})\n  {}",
                inc.name, inc.status, inc.impact, inc.url
            ));
            /* The newest note only. There are rarely more than four, and the
               older ones are the history of a thing you are being told about
               now — the widget can open them out because a person reads at
               their own pace, and an agent does not. */
            if let Some(n) = inc.notes.first() {
                out.push_str(&format!("\n  {}: {}", n.status, n.body.trim()));
            }
        }
        out.push_str(
            "\n\nIf what you were doing failed, this is very likely why. Say so to the \
             user rather than working around it, and do not rewrite working code to \
             accommodate an outage that will end.",
        );
    }

    /* When the page last said anything, which is not when we asked. The widget
       keeps those two apart for the same reason, and it matters more here: an
       agent has no clock on the wall to check the answer against. */
    if !h.updated_at.is_empty() {
        out.push_str(&format!("\n\n(page last updated {})", h.updated_at));
    }
    out
}

#[cfg(test)]
mod told {
    use super::*;

    fn part(name: &str, status: &str, group: bool) -> Part {
        Part {
            name: name.into(),
            status: status.into(),
            position: 1,
            group,
            hidden_when_well: false,
        }
    }

    fn health(indicator: &str, description: &str, components: Vec<Part>) -> Health {
        Health {
            indicator: indicator.into(),
            description: description.into(),
            updated_at: "2026-09-04T01:00:00.000Z".into(),
            components,
            incidents: vec![],
            maintenances: vec![],
        }
    }

    #[test]
    fn a_calm_page_says_so_without_licensing_a_retry_loop() {
        let s = say(&health(
            "none",
            "All Systems Operational",
            vec![part("Claude Code", "operational", false)],
        ));
        assert!(s.contains("Claude looks up"));
        /* Verbatim, never paraphrased — an agent repeats what it is told as
           fact, so what it repeats must be what the page said. */
        assert!(s.contains("All Systems Operational"));
        /* The half that stops this becoming a retry loop. A green page leaves
           both a transient error and the agent's own bug entirely possible. */
        assert!(
            s.contains("retrying in a loop is not"),
            "a green reading did not discourage a retry loop: {s}"
        );
    }

    /// The one dishonest thing this could do: the page is entitled to call a
    /// degraded component `none`, and has been observed doing it. Printing "all
    /// operational" over a component that says it is down would be the widget's
    /// "arguing with itself" bug, in a place an agent would act on.
    #[test]
    fn a_degraded_component_outranks_a_calm_indicator() {
        let s = say(&health(
            "none",
            "All Systems Operational",
            vec![part("Claude Code", "major_outage", false)],
        ));
        assert!(
            s.contains("NOT fully up"),
            "a down component was reported as everything being fine: {s}"
        );
        assert!(s.contains("Claude Code"));
        assert!(s.contains("major_outage"));
    }

    /// A heading is not a service. Counting one as degraded would report an
    /// outage that does not exist, which is the expensive direction here: an
    /// agent told it is an outage stops work and tells the user.
    #[test]
    fn a_group_row_is_not_a_service() {
        let s = say(&health(
            "none",
            "All Systems Operational",
            vec![part("API", "degraded_performance", true)],
        ));
        assert!(s.contains("Claude looks up"), "a group row was read as an outage: {s}");
    }

    #[test]
    fn an_incident_is_named_with_its_newest_note_and_its_link() {
        let mut h = health("major", "Major Service Outage", vec![]);
        h.incidents = vec![Incident {
            id: "n0".into(),
            name: "Elevated error rates".into(),
            status: "investigating".into(),
            impact: "major".into(),
            url: "https://stspg.io/abc".into(),
            started_at: "2026-09-04T00:30:00.000Z".into(),
            /* Newest first, as Statuspage sends them — so the first is the one
               that is true now and the rest are history. */
            notes: vec![
                Note {
                    status: "investigating".into(),
                    body: "  We are looking into it.  ".into(),
                    at: "2026-09-04T00:40:00.000Z".into(),
                },
                Note {
                    status: "identified".into(),
                    body: "An older note nobody needs.".into(),
                    at: "2026-09-04T00:31:00.000Z".into(),
                },
            ],
            affects: vec![],
        }];
        let s = say(&h);
        assert!(s.contains("Elevated error rates"));
        assert!(s.contains("https://stspg.io/abc"));
        assert!(s.contains("We are looking into it."));
        assert!(
            !s.contains("An older note nobody needs"),
            "every note was printed; only the newest is true now: {s}"
        );
        /* The instruction that stops an outage becoming a refactor. */
        assert!(s.contains("do not rewrite working code"));
    }

    /// When the *page* last spoke, which is not when we asked. An agent has no
    /// clock on the wall to check the answer against, so the stamp has to be in
    /// the answer.
    #[test]
    fn the_reading_carries_the_pages_own_timestamp() {
        let s = say(&health("none", "All Systems Operational", vec![]));
        assert!(s.contains("2026-09-04T01:00:00.000Z"));
    }

    #[test]
    fn the_handler_claims_its_own_name_and_nothing_else() {
        assert!(handle("board", &serde_json::json!({})).is_none());
        assert_eq!(status_schema()["name"], STATUS_TOOL);
    }

    /// It must stay OUT of the always-loaded tier. That tier is in front of
    /// every agent on every turn of every card, and this tool's whole argument
    /// for being deferred is that its question always arrives with an error
    /// message attached to prompt the search.
    #[test]
    fn it_is_not_in_the_tier_every_turn_pays_for() {
        let mine = crate::ask::roster()
            .into_iter()
            .find(|t| t["name"] == STATUS_TOOL)
            .expect("the status tool is advertised at all");
        assert_ne!(
            mine["_meta"]["anthropic/alwaysLoad"],
            serde_json::json!(true),
            "the status tool was promoted into the loaded tier; if that is deliberate, \
             say why where the schema is written"
        );
    }
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
