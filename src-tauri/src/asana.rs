//! A project's board, read out of Asana — and one card moved between columns.
//!
//! Five commands and one shape. `asana_workspaces` and `asana_projects` are for
//! choosing what to draw; `asana_board` is the reading; `asana_move` is the only
//! thing in this file that writes anything.
//!
//! ## Sections are columns
//!
//! Asana has no separate notion of a board column. A *section* is a subdivision
//! of a project that draws as a header in list view and as a column in board
//! view — one concept, two renderings — so `GET /projects/{gid}/sections` is the
//! column list and `POST /sections/{gid}/addTask` is the move. The API says this
//! outright, and it is worth stating here because "custom status columns" is
//! what a person calls them and `custom_fields` is a different feature
//! altogether. If a board is ever found whose columns are an enum custom field
//! rather than sections, that is a second reading and not a bug in this one.
//!
//! ## Probed against the live API, 2026-09-03
//!
//! Every shape below was read off `app.asana.com` with a real token on the
//! `lagardere-tr.com` workspace, rather than off the reference — and one of the
//! things it proved is the trap `asana_move` is built around. What it returned:
//!
//! - `GET /users/me` → `data.name`, `data.email`. Both present; the panel's
//!   check reads exactly these.
//! - `GET /workspaces` → one row. `GET /projects?workspace=…&archived=false&limit=100`
//!   → 64 rows, `next_page: null`, so one page covers a real tenant. Of those
//!   64, `opt_fields=members` matched against `/users/me` picks out **three** —
//!   and they are exactly the three Asana's own sidebar shows under Work
//!   (`T&D Team`, `RISE`, `Asana Onboarding – …`). `favorites` was the other
//!   candidate for that list and returned only one of them, so membership is
//!   the right notion and starring is not.
//! - `GET /projects/{gid}` → `name` and `permalink_url` as asked for.
//! - `GET /projects/{gid}/sections` → the columns, in board order.
//! - `GET /tasks?project=…&completed_since=now` → 10 rows where the sections
//!   between them hold 19, which confirms `completed_since` filters the
//!   *checkmark* and not the column. `assignee` is frequently `null` outright
//!   rather than absent, and `memberships[].project.gid` / `.section.gid` came
//!   back exactly as `section_of` matches on them.
//! - `POST /sections/{gid}/addTask` with `insert_before` → 200, landed above
//!   the named task. With `insert_after` → 200, landed below it. **With
//!   neither → 200, and the task jumped from the bottom of the column to the
//!   top.** That last one is the whole reason `plan` in `asana.ts` always sends
//!   a position, and it is now measured rather than read.
//!
//! The board it was measured on was put back byte-for-byte afterwards.
//!
//! ## The credential
//!
//! An Asana personal access token, from `creds.rs`, read per request rather
//! than cached. Asana PATs are unscoped, so unlike Azure DevOps there is no
//! ladder and no rung to name — the panel says so (`sole: true` in
//! `integrations.ts`), because an empty row here is not a row you may never
//! need, it is the reason the widget is blank.
//!
//! Reading the vault per request costs a syscall and buys the property
//! `vault.rs` chose Credential Manager for: a token deleted in Control Panel
//! stops working immediately rather than at the next detach.
//!
//! ## What this does not do
//!
//! It does not create, complete, rename, comment on or delete anything. The
//! same argument `azdo.rs` makes about not offering "re-run failed jobs" beside
//! a job list, and it is stronger here: a wall you glance at is not a place to
//! put a destructive verb, and a drag is a gesture you can make by accident.
//! Moving a card between columns is the one write, it is reversible by dragging
//! it back, and it is the thing the widget exists for.

use serde::{Deserialize, Serialize};

/// Where the API lives. Version 1.0 is the only one there has ever been.
const BASE: &str = "https://app.asana.com/api/1.0";

/// The service id `creds.rs` knows this token by.
const SERVICE: &str = "asana";

/// How many tasks one board reading will fetch, across however many pages.
///
/// Asana caps a page at 100 and hands back an offset, so this is a number of
/// *requests* as much as a number of tasks. Four pages against one host for a
/// widget on a wall is polite; forty would not be, and a board with four
/// thousand live tasks on it is not a board anybody reads at a glance anyway.
///
/// **What is dropped is reported, never silently cut.** `Board::more` carries
/// the count and the face says so — a truncated reading that looks complete is
/// an instrument claiming to know something it does not, which is the same
/// argument `Runs.unseen` makes one service over.
const MAX_TASKS: usize = 400;
const PAGE: usize = 100;

/* ── the shapes the front end draws ────────────────────────────────────────*/

/// A workspace or a project: a gid and what it is called.
///
/// One type for both because that is genuinely all either is at this layer, and
/// two identical structs would be two things to keep in step for no reader's
/// benefit.
#[derive(Serialize, Clone)]
pub struct Named {
    pub gid: String,
    pub name: String,
    /// Whether *you* are a member of it — false for a workspace or a section,
    /// which nobody is a member of in this sense.
    ///
    /// This is the difference between the 64 projects a token can see and the
    /// three in your own sidebar, and it is the whole reason the picker is
    /// usable. Measured 2026-09-03: `members` on the project list, matched
    /// against `/users/me`, returns exactly the three Asana's own sidebar shows
    /// under Work — and it comes back in the *same request* as the names, so
    /// the distinction costs one `opt_field` rather than a second pass.
    pub mine: bool,
}

/// A project, with what its owner last said about it.
///
/// One request answers the whole list — `GET /projects` takes the same
/// `opt_fields` the single-project endpoint does — which is what makes a health
/// grid over sixty-four projects affordable at all. Per project it would be
/// sixty-four requests a poll, which is not a widget, it is an outage.
#[derive(Serialize, Clone)]
pub struct Project {
    pub gid: String,
    pub name: String,
    pub url: String,
    /// Whether you are a member of it — see the note on `has_member`.
    pub mine: bool,
    /// The status update's own word for how it is going, verbatim.
    ///
    /// **Two fields, because Asana is mid-migration and both are documented.**
    /// `current_status_update.status_type` is the one new integrations are told
    /// to prefer and answers `on_track` / `at_risk` / `off_track` / `on_hold` /
    /// `complete` / `dropped`; `current_status.color` is the deprecated one and
    /// answers `green` / `yellow` / `red` / `blue` / `complete`. Whichever
    /// arrives is carried here as it came, and `asana.ts` owns the whole
    /// taxonomy — the same arrangement `azdo.ts` has for two forges' build
    /// states, and for the same reason: folding a vocabulary in Rust is where a
    /// state one side has and the other does not gets quietly turned into a lie.
    pub status: String,
    /// What the update was headed, if there is one. Quoted rather than
    /// reworded: it is a sentence a person wrote about their own project.
    pub said: String,
    pub owner: String,
    /// `due_on`, an ISO date, or empty.
    pub due: String,
}

#[derive(Serialize, Clone)]
pub struct Card {
    pub gid: String,
    pub name: String,
    /// Who it is on, or empty. A name rather than a gid: this is drawn, never
    /// matched on.
    pub assignee: String,
    /// `due_on`, an ISO date with no time (`2026-09-12`), or empty. Asana also
    /// has `due_at` for tasks with a time on them; the date is what a board
    /// column shows and the comparison the face makes is against today.
    pub due: String,
    /// Whether the checkmark is ticked. **Not** whether it is in a "done"
    /// column — those are different facts, and conflating them is the first
    /// thing anybody gets wrong about Asana. A task can sit in a Done section
    /// for weeks without being completed, and a completed task stays in
    /// whatever section it was in.
    pub completed: bool,
    /// Where to open it. Asana's own permalink, so the gesture leaves the app
    /// through `open.rs` the way every other link on this wall does.
    pub url: String,
    /// The custom fields with a value on them, as `name` and a readable string.
    ///
    /// **`display_value` and never the typed value.** Asana's own advice, and
    /// the reason is the one this app cares about: "integrations that don't
    /// require the underlying type should use this field", which means a new
    /// custom field type costs no code here. An enum, a number, a date and a
    /// people field all arrive as a string somebody chose the formatting of,
    /// which is exactly what a chip on a card wants.
    pub fields: Vec<Field>,
}

#[derive(Serialize, Clone)]
pub struct Field {
    pub name: String,
    pub value: String,
}

/// A task on you, and the project it is in.
#[derive(Serialize, Clone)]
pub struct Assigned {
    #[serde(flatten)]
    pub card: Card,
    pub project: String,
}

#[derive(Serialize, Clone)]
pub struct Column {
    pub gid: String,
    pub name: String,
    pub cards: Vec<Card>,
}

#[derive(Serialize, Clone)]
pub struct Board {
    pub project: String,
    pub name: String,
    pub url: String,
    pub columns: Vec<Column>,
    /// Tasks this reading did not fetch, because `MAX_TASKS` stopped it. Zero
    /// in every ordinary case; see the constant.
    pub more: usize,
    /// How many requests this reading cost. Reported rather than merely
    /// counted, the same as `Runs.asked`: this is somebody else's server.
    pub asked: usize,
}

/* ── reading ───────────────────────────────────────────────────────────────*/

/// Every workspace the token can see.
///
/// The first call anything makes, and the cheapest thing that proves the token
/// works — though the panel's `check it` uses `/users/me` rather than this,
/// because that one also names the account.
#[tauri::command]
pub async fn asana_workspaces() -> Result<Vec<Named>, String> {
    crate::off_main(|| {
        let v = get("/workspaces?opt_fields=name")?;
        Ok(named(&v))
    })
    .await?
}

/// Every unarchived project in a workspace.
///
/// `archived=false` because an archived project is one somebody deliberately
/// put away, and offering a hundred of them in a picker is a picker nobody can
/// use. A board widget pointed at a project that is *later* archived keeps
/// working — the reading is by gid and does not go back through this list —
/// which is the right way round: the widget on your wall does not stop drawing
/// because somebody tidied up.
///
/// **Each row says whether you are a member of it**, which is the distinction
/// that makes a picker over 64 projects usable: the handful you actually work
/// in are the ones Asana's own sidebar shows you, and they are exactly the ones
/// you are a member of. `members` is an `opt_field` on the same list request,
/// so this costs one extra field and one cheap `/users/me` rather than a second
/// pass over the projects.
#[tauri::command]
pub async fn asana_projects(workspace: String) -> Result<Vec<Project>, String> {
    crate::off_main(move || {
        /* Who "mine" means. Asked here rather than passed in, so the command is
           self-contained and no caller can hand it the wrong identity — and it
           is the same request the tokens panel's check makes, which is to say
           the cheapest authenticated call there is. */
        let me = get("/users/me?opt_fields=gid")?;
        let me = crate::forge::text(me.get("data").unwrap_or(&serde_json::Value::Null), "gid");
        /* One request for names, membership *and* health, so the health grid
           and the board's picker are the same reading at two cadences rather
           than two readings. That is the only reason a status per project is
           affordable: asked one project at a time it would be sixty-four
           requests a poll on this workspace. Both status fields are asked for;
           see `Project::status`. */
        let v = get(&format!(
            "/projects?workspace={workspace}&archived=false&limit=100\
             &opt_fields=name,permalink_url,members,owner.name,due_on,\
             current_status_update.status_type,current_status_update.title,\
             current_status.color,current_status.title"
        ))?;
        Ok(v.get("data")
            .and_then(|d| d.as_array())
            .map(|rows| rows.iter().filter_map(|r| project_of(r, &me)).collect())
            .unwrap_or_default())
    })
    .await?
}

/// What is assigned to you, across the whole workspace.
///
/// `assignee=me` **requires** `workspace` — Asana refuses the pair otherwise —
/// which is why this takes one rather than answering for the account at large.
/// One request, and the cheapest useful thing in this file: the reading a
/// developer glances at twenty times a day.
///
/// The project name rides along on `memberships`, so a task knows where it came
/// from without a second lookup. A task in several projects reports the first,
/// because a row has space for one and "which of these is it really" is a
/// question the person looking already knows the answer to.
#[tauri::command]
pub async fn asana_mine(workspace: String, open: bool) -> Result<Vec<Assigned>, String> {
    crate::off_main(move || {
        let mut url = format!(
            "/tasks?assignee=me&workspace={workspace}&limit=100\
             &opt_fields=name,completed,due_on,permalink_url,assignee.name,\
             custom_fields.name,custom_fields.display_value,\
             memberships.project.name"
        );
        if open {
            url.push_str("&completed_since=now");
        }
        let v = get(&url)?;
        Ok(v.get("data")
            .and_then(|d| d.as_array())
            .map(|rows| {
                rows.iter()
                    .map(|r| Assigned { card: card_of(r), project: first_project(r) })
                    .collect()
            })
            .unwrap_or_default())
    })
    .await?
}

/// One project row, or None where there is no gid to act on.
fn project_of(row: &serde_json::Value, me: &str) -> Option<Project> {
    let gid = crate::forge::text(row, "gid");
    if gid.is_empty() {
        return None;
    }
    /* The preferred field first and the deprecated one behind it, read in that
       order rather than merged — so a project answering both is described by
       the one Asana says to use. */
    let newer = row.get("current_status_update");
    let older = row.get("current_status");
    let pick = |key_new: &str, key_old: &str| -> String {
        newer
            .map(|u| crate::forge::text(u, key_new))
            .filter(|s| !s.is_empty())
            .or_else(|| {
                older
                    .map(|u| crate::forge::text(u, key_old))
                    .filter(|s| !s.is_empty())
            })
            .unwrap_or_default()
    };
    Some(Project {
        gid,
        name: crate::forge::text(row, "name"),
        url: crate::forge::text(row, "permalink_url"),
        mine: !me.is_empty() && has_member(row, me),
        status: pick("status_type", "color"),
        said: pick("title", "title"),
        owner: row
            .get("owner")
            .map(|o| crate::forge::text(o, "name"))
            .unwrap_or_default(),
        due: crate::forge::text(row, "due_on"),
    })
}

/// The first project a task is in, by name. Empty for a task in none.
fn first_project(row: &serde_json::Value) -> String {
    row.get("memberships")
        .and_then(|m| m.as_array())
        .and_then(|ms| ms.first())
        .and_then(|m| m.get("project"))
        .map(|p| crate::forge::text(p, "name"))
        .unwrap_or_default()
}

/// Whether a project row lists this user among its members.
///
/// Absent rather than empty is the ordinary case for a project nobody has been
/// added to, so a missing `members` is "no" and not an error.
fn has_member(row: &serde_json::Value, me: &str) -> bool {
    row.get("members")
        .and_then(|m| m.as_array())
        .is_some_and(|ms| ms.iter().any(|m| crate::forge::text(m, "gid") == me))
}

/// One project's board.
///
/// Three requests plus a page per hundred tasks: the project (for its name and
/// permalink), its sections, and its tasks. **The tasks come in one query with
/// `memberships` rather than one query per section**, which is the whole reason
/// this is three requests and not one-per-column — a nine-column board would
/// otherwise cost eleven round trips per poll, on a timer, against somebody
/// else's server.
///
/// `open` excludes tasks whose checkmark is ticked, via `completed_since=now`.
/// That is Asana's idiom for "incomplete only" and it reads oddly: the
/// parameter means *completed since this instant*, and nothing has been, so
/// what comes back is the incomplete ones. It is a filter on the checkmark and
/// not on the section, so a Done column still draws — see `Card::completed`.
#[tauri::command]
pub async fn asana_board(project: String, open: bool) -> Result<Board, String> {
    crate::off_main(move || {
        let mut asked = 0usize;

        let head = get(&format!("/projects/{project}?opt_fields=name,permalink_url"))?;
        asked += 1;
        let head = head.get("data").cloned().unwrap_or(serde_json::Value::Null);

        let secs = get(&format!("/projects/{project}/sections?opt_fields=name"))?;
        asked += 1;
        let mut columns: Vec<Column> = named(&secs)
            .into_iter()
            .map(|n| Column { gid: n.gid, name: n.name, cards: Vec::new() })
            .collect();

        /* Where a task with no section membership goes. Asana allows it — a task
           added to a project without being put in a column — and dropping those
           on the floor would make the board quietly disagree with the count in
           Asana's own header. Only created if something lands in it, so an
           ordinary board grows no phantom column.

           Its gid is empty, which is what stops it being a drop target: a move
           needs a section to POST to and there is none. */
        let mut loose: Vec<Card> = Vec::new();

        let mut offset: Option<String> = None;
        let mut more = 0usize;
        let mut got = 0usize;
        loop {
            let page = PAGE.min(MAX_TASKS - got);
            let mut url = format!(
                "/tasks?project={project}&limit={page}\
                 &opt_fields=name,completed,due_on,permalink_url,assignee.name,\
                 custom_fields.name,custom_fields.display_value,\
                 memberships.section.gid,memberships.project.gid"
            );
            if open {
                url.push_str("&completed_since=now");
            }
            if let Some(o) = &offset {
                url.push_str(&format!("&offset={o}"));
            }
            let v = get(&url)?;
            asked += 1;
            let rows = v.get("data").and_then(|d| d.as_array()).cloned().unwrap_or_default();
            got += rows.len();
            for row in &rows {
                let card = card_of(row);
                match section_of(row, &project) {
                    Some(sec) => match columns.iter_mut().find(|c| c.gid == sec) {
                        Some(col) => col.cards.push(card),
                        /* A section the section list did not have. Ordinary
                           under a race — somebody added a column between the
                           two requests — and the honest place for it is the
                           unsectioned pile rather than a column invented here,
                           since we do not know its name or where it sits. */
                        None => loose.push(card),
                    },
                    None => loose.push(card),
                }
            }
            offset = v
                .get("next_page")
                .and_then(|p| p.get("offset"))
                .and_then(|o| o.as_str())
                .map(|s| s.to_string());
            if offset.is_none() {
                break;
            }
            if got >= MAX_TASKS {
                /* There is another page and we are not fetching it. The count is
                   a floor rather than a total — Asana does not say how many are
                   left — so the face says "at least", which is the only honest
                   reading available. */
                more = 1;
                break;
            }
        }

        if !loose.is_empty() {
            columns.push(Column { gid: String::new(), name: "no column".into(), cards: loose });
        }

        Ok(Board {
            project,
            name: crate::forge::text(&head, "name"),
            url: crate::forge::text(&head, "permalink_url"),
            columns,
            more,
            asked,
        })
    })
    .await?
}

/* ── the one write ─────────────────────────────────────────────────────────*/

#[derive(Deserialize)]
pub struct Move {
    pub task: String,
    pub section: String,
    /// The task this one should land above, if any.
    pub before: Option<String>,
    /// Or the task it should land below. Mutually exclusive with `before` —
    /// Asana refuses both — and the front end sends at most one; `plan` in
    /// `asana.ts` is what decides which, because that is the same decision as
    /// where to draw the card, and making it twice is how the two disagree.
    pub after: Option<String>,
}

/// Move a task into a section, at a position.
///
/// `POST /sections/{gid}/addTask` **removes the task from every other section of
/// the project** as part of the same call, which is what makes this one request
/// rather than a remove and an add — and what makes it safe to retry: the
/// operation is idempotent in the position it names.
///
/// With neither `insert_before` nor `insert_after`, Asana puts the task at the
/// **top** of the section — measured 2026-09-03, not merely read: a task sitting
/// at the bottom of a two-card column was re-added with no position and came
/// back at the top. That is a real trap rather than a detail: a widget
/// that drew the card where you dropped it and sent no position would show it
/// at the bottom and have it jump to the top on the next poll, which reads as
/// the app having lost the drag. So the front end always sends a position when
/// the column has any cards in it, and the two agree because one function
/// decides both.
#[tauri::command]
pub async fn asana_move(mv: Move) -> Result<(), String> {
    crate::off_main(move || {
        if mv.section.is_empty() {
            /* The unsectioned pile. It is a real place a task can be and not a
               place one can be *put*: there is no section to POST to. Refused
               here rather than in the face, so no path can produce a request
               with an empty gid in its URL. */
            return Err("that column is not one Asana can move a card into".to_string());
        }
        let mut data = serde_json::Map::new();
        data.insert("task".into(), serde_json::Value::String(mv.task.clone()));
        match (&mv.before, &mv.after) {
            (Some(b), _) if !b.is_empty() => {
                data.insert("insert_before".into(), serde_json::Value::String(b.clone()));
            }
            (_, Some(a)) if !a.is_empty() => {
                data.insert("insert_after".into(), serde_json::Value::String(a.clone()));
            }
            _ => {}
        }
        post(
            &format!("/sections/{}/addTask", mv.section),
            serde_json::json!({ "data": data }),
        )
        .map(|_| ())
    })
    .await?
}

/* ── the wire ──────────────────────────────────────────────────────────────*/

fn token() -> Result<String, String> {
    crate::creds::token(SERVICE).ok_or_else(|| {
        "no asana token stored — the tokens panel in the header takes one".to_string()
    })
}

fn get(path: &str) -> Result<serde_json::Value, String> {
    let token = token()?;
    answer(
        crate::forge::agent()
            .get(&format!("{BASE}{path}"))
            .set("Authorization", &format!("Bearer {token}"))
            .set("Accept", "application/json")
            .call(),
    )
}

fn post(path: &str, body: serde_json::Value) -> Result<serde_json::Value, String> {
    let token = token()?;
    answer(
        crate::forge::agent()
            .post(&format!("{BASE}{path}"))
            .set("Authorization", &format!("Bearer {token}"))
            .set("Accept", "application/json")
            .send_json(body),
    )
}

/// One answer, or one sentence about why there is none.
///
/// The status code is kept in the message, because the three that mean
/// different things here are worth telling apart by somebody reading a widget:
/// **401** is the token, **403** is the account not being on this thing, and
/// **429** is Asana's rate limit, which is a reason to leave it alone for a
/// minute rather than to go and re-mint anything.
fn answer(res: Result<ureq::Response, ureq::Error>) -> Result<serde_json::Value, String> {
    match res {
        Ok(res) => res
            .into_json()
            .map_err(|e| format!("unreadable answer from asana: {e}")),
        Err(ureq::Error::Status(code, res)) => {
            let body = res.into_string().unwrap_or_default();
            Err(format!("asana answered {code}{}", said(&body)))
        }
        Err(e) => Err(format!("could not reach asana: {e}")),
    }
}

/// Asana's own words about a refusal, as a suffix or as nothing.
///
/// The shape is `{"errors":[{"message": …}]}`. Anything else — an HTML sign-in
/// page from a TLS-intercepting proxy is the case that actually happens — gives
/// up quietly, because a status code alone is a short true sentence and a page
/// of markup beside it is not a longer one.
fn said(body: &str) -> String {
    let msg = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| {
            v.pointer("/errors/0/message")
                .and_then(|m| m.as_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_default();
    let msg = msg.lines().next().unwrap_or("").trim().to_string();
    if msg.is_empty() {
        String::new()
    } else {
        format!(": {msg}")
    }
}

/* ── reading the json ──────────────────────────────────────────────────────*/

/// `{"data": [{gid, name}, …]}` — the shape three of the four reads answer in.
fn named(v: &serde_json::Value) -> Vec<Named> {
    v.get("data")
        .and_then(|d| d.as_array())
        .map(|rows| {
            rows.iter()
                .filter_map(|r| {
                    let gid = crate::forge::text(r, "gid");
                    /* A row with no gid is a row nothing can be done with — it
                       cannot be fetched, moved or opened — so it is dropped
                       rather than drawn as a nameless entry somebody would then
                       click on. */
                    /* `mine` is meaningless for a workspace or a section —
                       nobody is a member of one in this sense — so it is false
                       rather than optional. The one reader that can answer it
                       is `asana_projects`, which builds its rows itself. */
                    (!gid.is_empty()).then(|| Named {
                        gid,
                        name: crate::forge::text(r, "name"),
                        mine: false,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn card_of(row: &serde_json::Value) -> Card {
    Card {
        gid: crate::forge::text(row, "gid"),
        name: crate::forge::text(row, "name"),
        assignee: row
            .get("assignee")
            .map(|a| crate::forge::text(a, "name"))
            .unwrap_or_default(),
        due: crate::forge::text(row, "due_on"),
        completed: row.get("completed").and_then(|c| c.as_bool()).unwrap_or(false),
        url: crate::forge::text(row, "permalink_url"),
        fields: fields_of(row),
    }
}

/// The custom fields worth drawing: the ones with a value.
///
/// A board typically defines several and sets two, so keeping the empty ones
/// would put blank chips on every card — and an empty chip is worse than no
/// chip, since it reads as a value that failed to load.
fn fields_of(row: &serde_json::Value) -> Vec<Field> {
    row.get("custom_fields")
        .and_then(|f| f.as_array())
        .map(|fs| {
            fs.iter()
                .filter_map(|f| {
                    let name = crate::forge::text(f, "name");
                    let value = crate::forge::text(f, "display_value");
                    (!name.is_empty() && !value.is_empty()).then_some(Field { name, value })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Which section of *this* project a task is in.
///
/// A task can be in many projects at once, so `memberships` is a list and the
/// project gid has to be matched — taking the first membership would put a card
/// in whichever column it happens to occupy on somebody else's board, which
/// draws as a column that is not on this project at all.
fn section_of(row: &serde_json::Value, project: &str) -> Option<String> {
    for m in row.get("memberships")?.as_array()? {
        let in_project = m.get("project").map(|p| crate::forge::text(p, "gid"));
        if in_project.as_deref() != Some(project) {
            continue;
        }
        let sec = m.get("section").map(|s| crate::forge::text(s, "gid"))?;
        if !sec.is_empty() {
            return Some(sec);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One task as `GET /tasks` answers it with the `opt_fields` above, trimmed
    /// to the fields that are read. Two memberships on purpose: this is the
    /// shape that made `section_of` match on the project gid rather than taking
    /// the first entry.
    fn a_task() -> serde_json::Value {
        serde_json::json!({
            "gid": "1201",
            "name": "Rebuild the floor plan importer",
            "completed": false,
            "due_on": "2026-09-12",
            "permalink_url": "https://app.asana.com/0/1/1201",
            "assignee": { "gid": "77", "name": "Lyss Delprat" },
            "memberships": [
                { "project": { "gid": "999" }, "section": { "gid": "9991" } },
                { "project": { "gid": "500" }, "section": { "gid": "5002" } }
            ]
        })
    }

    #[test]
    fn a_card_is_read_out_of_one_task() {
        let c = card_of(&a_task());
        assert_eq!(c.gid, "1201");
        assert_eq!(c.assignee, "Lyss Delprat");
        assert_eq!(c.due, "2026-09-12");
        assert!(!c.completed);
    }

    #[test]
    fn the_section_is_this_projects_and_not_the_first_one() {
        /* The bug this exists to prevent: taking `memberships[0]` puts the card
           in whichever column it occupies on somebody *else's* board, which
           draws as a column that is not on this project at all. */
        assert_eq!(section_of(&a_task(), "500").as_deref(), Some("5002"));
        assert_eq!(section_of(&a_task(), "999").as_deref(), Some("9991"));
    }

    #[test]
    fn a_task_in_no_column_of_this_project_has_no_section() {
        assert_eq!(section_of(&a_task(), "123"), None);

        /* And the other way a task has no column: it is in the project and was
           never put in a section. Asana allows this and the board has to draw
           it somewhere, or the count disagrees with Asana's own header. */
        let bare = serde_json::json!({
            "gid": "7",
            "memberships": [{ "project": { "gid": "999" }, "section": serde_json::Value::Null }]
        });
        assert_eq!(section_of(&bare, "999"), None);
    }

    #[test]
    fn a_row_with_no_gid_is_dropped_rather_than_drawn() {
        let v = serde_json::json!({ "data": [
            { "gid": "1", "name": "Backlog" },
            { "name": "a row nothing can be done with" },
            { "gid": "2", "name": "Doing" }
        ]});
        let out = named(&v);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].gid, "1");
        assert_eq!(out[1].gid, "2");
    }

    #[test]
    fn membership_is_read_off_the_same_row_as_the_name() {
        /* The distinction that makes a picker over 64 projects usable: the
           three you are a member of are the three Asana's own sidebar shows.
           Absent `members` is "no" rather than an error — an ordinary shape for
           a project nobody has been added to. */
        let mine = serde_json::json!({
            "gid": "1", "name": "RISE",
            "members": [{ "gid": "77" }, { "gid": "88" }]
        });
        let theirs = serde_json::json!({ "gid": "2", "name": "SandBox", "members": [{ "gid": "88" }] });
        let bare = serde_json::json!({ "gid": "3", "name": "Projet 1" });
        assert!(has_member(&mine, "77"));
        assert!(!has_member(&theirs, "77"));
        assert!(!has_member(&bare, "77"));
    }

    #[test]
    fn a_refusal_is_quoted_and_a_sign_in_page_is_not() {
        assert_eq!(
            said(r#"{"errors":[{"message":"Not Authorized"}]}"#),
            ": Not Authorized"
        );
        assert_eq!(said("<!DOCTYPE html><html>Sign in"), "");
        assert_eq!(said(""), "");
    }
}
