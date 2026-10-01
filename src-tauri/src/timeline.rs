//! Timelines: a card's plan for a long piece of work, drawn on the glass as a
//! frise and kept current by the card as the work moves.
//!
//! A transcript says what happened; a turn's summary says what just happened.
//! Neither answers the question somebody running ten cards actually has, which
//! is *how far along is this* — and the card is the only thing on the wall that
//! knows. So the card draws it: major steps, the sub-steps inside each, and
//! **strands** where a step's work runs in parallel (a background task, a split
//! between two halves), each with its own live marker.
//!
//! ### One live timeline per card, and why that is not one strand
//!
//! A card holds at most one live timeline. Tools then need no id — the card's
//! own is the only one it can mean — and the wall never has to decide which of
//! a card's three plans is the real one. Parallel work is not a second
//! timeline; it is a step forking into strands, which keeps the parallel parts
//! inside the plan they belong to rather than beside it.
//!
//! ### Two writes, priced differently
//!
//! `timeline_set` takes the whole plan and is what a card calls when the plan
//! itself changes. `timeline_mark` moves states by path (`3.ui.2`) and is what
//! it calls as work moves — a few dozen tokens rather than the whole plan again,
//! which is the difference between a card that keeps its timeline honest and
//! one that stops bothering. A `set` carries forward the state of every item it
//! can match in the old plan, so restructuring does not mean restating progress.
//!
//! ### Owner writes; anybody reads
//!
//! Reading is wall-wide: a card that spawned children in another project wants
//! to see how far each has got without a `send` costing the child a turn —
//! `relay::recall`'s argument, one surface over. Writing is the owner's alone.
//!
//! ### What the states mean on the wall
//!
//! `live` is on the glass and moving. `complete` is on the glass and finished,
//! waiting for the user's archive click. `left` is a live timeline whose card was
//! closed: it goes straight to the archive with a marker where it stopped, and
//! the archive offers to pick it back up by adopting the session that made it.
//! On the glass means `archived_at IS NULL`; the state says why it is or is not.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use rusqlite::{params, Connection};

use crate::store::Store;

pub const READ_TOOL: &str = "timeline";
pub const SET_TOOL: &str = "timeline_set";
pub const MARK_TOOL: &str = "timeline_mark";
pub const COMPLETE_TOOL: &str = "timeline_complete";

/* The bounds. A timeline is a reading at a glance, and every one of these is
   the size past which it stops being one — a twenty-step frise is a list drawn
   sideways, and a step description that needs a paragraph is a plan document,
   which the user said in as many words this is not. */
const MAX_TITLE: usize = 90;
const MAX_STEP_TITLE: usize = 48;
const MAX_ABOUT: usize = 240;
const MAX_SUB_TITLE: usize = 72;
const MAX_STRAND_NAME: usize = 24;
const MAX_STEPS: usize = 12;
const MAX_STRANDS: usize = 4;
const MAX_SUBS: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum State {
    #[default]
    Todo,
    Active,
    Done,
}

impl State {
    fn parse(s: &str) -> Option<State> {
        match s.trim().to_lowercase().as_str() {
            "todo" | "pending" | "open" => Some(State::Todo),
            "active" | "doing" | "live" | "in progress" | "in_progress" => Some(State::Active),
            "done" | "complete" | "completed" | "finished" => Some(State::Done),
            _ => None,
        }
    }
    fn glyph(self) -> &'static str {
        match self {
            State::Todo => "○",
            State::Active => "▸",
            State::Done => "✓",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Sub {
    pub title: String,
    #[serde(default)]
    pub state: State,
    #[serde(flatten)]
    pub marks: Marks,
}

/// Which write put an item on the plan, and which one marked it done — so a
/// click on it on the wall can carry the transcript to that exact call.
///
/// A revision rather than a time, because the thing being looked for is a tool
/// call in a transcript, and every write's answer ends with its revision
/// (`[timeline r7]`) — so the front end finds the call by what it *said*, which
/// is in the session file whether the card is live or read back off disk. A
/// timestamp would have to be matched against another clock.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct Marks {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub born: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub done: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Strand {
    /// Absent on the one strand of a step that does not fork.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub background: bool,
    #[serde(default)]
    pub subs: Vec<Sub>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Step {
    pub title: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub about: String,
    /// Read only when the step has no sub-steps at all — otherwise a step is
    /// exactly as far along as its sub-steps, and a second field saying so would
    /// be a second thing to keep in step.
    #[serde(default)]
    pub state: State,
    #[serde(default)]
    pub strands: Vec<Strand>,
    #[serde(flatten)]
    pub marks: Marks,
}

impl Step {
    fn subs(&self) -> impl Iterator<Item = &Sub> {
        self.strands.iter().flat_map(|s| s.subs.iter())
    }
    fn has_subs(&self) -> bool {
        self.subs().next().is_some()
    }
    /// The step's state as the wall reads it.
    fn effective(&self) -> State {
        if !self.has_subs() {
            return self.state;
        }
        if self.subs().all(|s| s.state == State::Done) {
            State::Done
        } else if self.subs().any(|s| s.state != State::Todo) {
            State::Active
        } else {
            State::Todo
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Plan {
    /// How many writes this plan has had. Every successful `set`, `mark` and
    /// `complete` takes the next one and says it in its answer.
    #[serde(default)]
    pub rev: u32,
    pub steps: Vec<Step>,
}

impl Plan {
    /// Done units over all units, an active one counting half — which is also
    /// where the frise draws it, at the middle of its span.
    fn fraction(&self) -> f64 {
        let (mut got, mut all) = (0.0, 0.0);
        for step in &self.steps {
            if step.has_subs() {
                for s in step.subs() {
                    all += 1.0;
                    got += worth(s.state);
                }
            } else {
                all += 1.0;
                got += worth(step.state);
            }
        }
        if all == 0.0 {
            0.0
        } else {
            got / all
        }
    }

    /// The first step that is not done, 1-based, or `None` when all are.
    fn current(&self) -> Option<usize> {
        self.steps
            .iter()
            .position(|s| s.effective() != State::Done)
            .map(|i| i + 1)
    }
}

fn worth(s: State) -> f64 {
    match s {
        State::Todo => 0.0,
        State::Active => 0.5,
        State::Done => 1.0,
    }
}

/* ── the row ─────────────────────────────────────────────────────────────── */

/// One timeline as the wall draws it. `plan` is the parsed plan rather than the
/// column's text, so the front end receives the same shape whichever way it
/// asked.
#[derive(Debug, Clone, Serialize)]
pub struct Row {
    pub id: String,
    pub owner_id: String,
    pub session_id: Option<String>,
    pub cwd: String,
    pub project: String,
    pub source: String,
    pub title: String,
    pub plan: Plan,
    pub state: String,
    pub archived_at: Option<i64>,
    pub glass_x: Option<f64>,
    pub glass_y: Option<f64>,
    pub born_at: i64,
    pub updated_at: i64,
    pub ended_at: Option<i64>,
}

const COLUMNS: &str = "id, owner_id, session_id, cwd, project, source, title, plan_json, state, \
                       archived_at, glass_x, glass_y, born_at, updated_at, ended_at";

fn row_of(r: &rusqlite::Row) -> rusqlite::Result<Row> {
    let plan_json: String = r.get(7)?;
    Ok(Row {
        id: r.get(0)?,
        owner_id: r.get(1)?,
        session_id: r.get(2)?,
        cwd: r.get(3)?,
        project: r.get(4)?,
        source: r.get(5)?,
        title: r.get(6)?,
        /* A plan this build cannot read is drawn as an empty one rather than
           failing the whole read — the same bargain the opaque JSON columns
           strike, for the one JSON column Rust does own. */
        plan: serde_json::from_str(&plan_json).unwrap_or_default(),
        state: r.get(8)?,
        archived_at: r.get(9)?,
        glass_x: r.get(10)?,
        glass_y: r.get(11)?,
        born_at: r.get(12)?,
        updated_at: r.get(13)?,
        ended_at: r.get(14)?,
    })
}

fn query(conn: &Connection, filter: &str, args: &[&dyn rusqlite::ToSql]) -> Vec<Row> {
    let sql = format!("SELECT {COLUMNS} FROM timeline WHERE {filter}");
    let Ok(mut stmt) = conn.prepare(&sql) else {
        return vec![];
    };
    let Ok(rows) = stmt.query_map(args, row_of) else {
        return vec![];
    };
    rows.flatten().collect()
}

/// The caller's live timeline, if it has one.
pub(crate) fn live_of(conn: &Connection, owner: &str) -> Option<Row> {
    query(
        conn,
        "owner_id = ?1 AND state = 'live' AND archived_at IS NULL ORDER BY born_at DESC LIMIT 1",
        &[&owner],
    )
    .into_iter()
    .next()
}

/// The newest timeline a card has, of any state — for reading one that has
/// just been completed, or another card's.
fn latest_of(conn: &Connection, owner: &str) -> Option<Row> {
    query(
        conn,
        "owner_id = ?1 ORDER BY (state = 'live') DESC, updated_at DESC LIMIT 1",
        &[&owner],
    )
    .into_iter()
    .next()
}

fn one(conn: &Connection, id: &str) -> Option<Row> {
    query(conn, "id = ?1", &[&id]).into_iter().next()
}

/// What a card that is about to be closed has in flight, as a sentence for a
/// question: `"store rollout", at step 3 of 5`. `None` when it has nothing live.
pub(crate) fn live_summary(conn: &Connection, owner: &str) -> Option<String> {
    let t = live_of(conn, owner)?;
    Some(format!("{:?}, {}", t.title, whereabouts(&t.plan)))
}

fn whereabouts(plan: &Plan) -> String {
    let pct = (plan.fraction() * 100.0).round() as i64;
    match plan.current() {
        Some(n) => format!("at step {n} of {} ({pct}%)", plan.steps.len()),
        None => format!("with every step done ({pct}%)"),
    }
}

/* ── telling the wall ────────────────────────────────────────────────────── */

#[derive(Clone, Serialize)]
struct Changed {
    /// The row as it now stands, or `None` when it is gone from the database.
    row: Option<Row>,
    id: String,
}

fn changed(app: &AppHandle, id: &str) {
    let row = app
        .try_state::<Store>()
        .and_then(|s| s.0.lock().ok().and_then(|c| one(&c, id)));
    let _ = app.emit("timeline:changed", Changed { row, id: id.to_string() });
}

/* ── parsing what a card sends ───────────────────────────────────────────── */

fn text(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn cap(s: &str, max: usize) -> String {
    crate::clip::preview(s, max)
}

/// A `state` as sent: absent is `None`, anything that is not one of the three
/// words is an error. Not `and_then(as_str)`, which read `"state": 5` as no state
/// at all and quietly made it `todo`.
fn state_in(v: Option<&Value>, what: &str) -> Option<Result<State, String>> {
    match v {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(State::parse(s).ok_or_else(|| {
            format!("{what}: {s:?} is not a state — use `todo`, `active` or `done`")
        })),
        Some(other) => Some(Err(format!(
            "{what}: a state is one of the words `todo`, `active` or `done`, not {other}"
        ))),
    }
}

/// A sub-step as sent: a bare string, or `{title, state}`.
fn sub_of(v: &Value) -> Result<(Sub, bool), String> {
    let (title, state) = match v {
        Value::String(s) => (Some(s.trim().to_string()), None),
        Value::Object(_) => (text(v.get("title")), state_in(v.get("state"), "a sub-step")),
        _ => (None, None),
    };
    let Some(title) = title.filter(|t| !t.is_empty()) else {
        return Err("every sub-step needs a title".into());
    };
    let (state, given) = match state {
        Some(Ok(s)) => (s, true),
        Some(Err(e)) => return Err(e),
        None => (State::Todo, false),
    };
    Ok((Sub { title: cap(&title, MAX_SUB_TITLE), state, marks: Marks::default() }, given))
}

/// Whether each item's state was written by the caller, so `carry` knows which
/// ones to fill in from the plan being replaced. Same shape as the plan.
type Given = Vec<(bool, Vec<Vec<bool>>)>;

fn subs_of(v: Option<&Value>) -> Result<(Vec<Sub>, Vec<bool>), String> {
    let Some(v) = v else { return Ok((vec![], vec![])) };
    let Some(items) = v.as_array() else {
        return Err("`subs` is a list of sub-steps".into());
    };
    if items.len() > MAX_SUBS {
        return Err(format!(
            "a strand holds at most {MAX_SUBS} sub-steps — this one has {}. A timeline \
             is read at a glance; fold the detail into fewer, larger sub-steps.",
            items.len()
        ));
    }
    let mut subs = vec![];
    let mut given = vec![];
    for item in items {
        let (s, g) = sub_of(item)?;
        subs.push(s);
        given.push(g);
    }
    Ok((subs, given))
}

fn plan_of(args: &Value) -> Result<(Plan, Given), String> {
    let Some(steps) = args.get("steps").and_then(Value::as_array) else {
        return Err("`steps` is required — the whole plan, in order".into());
    };
    if steps.is_empty() {
        return Err("a timeline needs at least one step".into());
    }
    if steps.len() > MAX_STEPS {
        return Err(format!(
            "a timeline holds at most {MAX_STEPS} major steps — this one has {}. Group \
             them; the sub-steps are where the detail goes.",
            steps.len()
        ));
    }
    let mut plan = Plan::default();
    let mut given: Given = vec![];
    for (i, s) in steps.iter().enumerate() {
        let Some(title) = text(s.get("title")) else {
            return Err(format!("step {} has no title", i + 1));
        };
        let about = text(s.get("about")).map(|a| cap(&a, MAX_ABOUT)).unwrap_or_default();
        let (state, step_given) = match state_in(s.get("state"), &format!("step {}", i + 1)) {
            Some(st) => (st?, true),
            None => (State::Todo, false),
        };

        let mut strands = vec![];
        let mut strand_given = vec![];
        if let Some(list) = s.get("strands").and_then(Value::as_array) {
            if s.get("subs").is_some() {
                return Err(format!(
                    "step {} has both `subs` and `strands` — use `subs` for one line of \
                     work, or `strands` when it runs in parallel, not both",
                    i + 1
                ));
            }
            if list.len() > MAX_STRANDS {
                return Err(format!(
                    "step {} has {} strands; at most {MAX_STRANDS} run in parallel",
                    i + 1,
                    list.len()
                ));
            }
            let mut names: Vec<String> = vec![];
            for (j, st) in list.iter().enumerate() {
                let Some(name) = text(st.get("name")) else {
                    return Err(format!(
                        "step {}: strand {} needs a `name` — it is how its sub-steps are \
                         addressed (`{}.<name>.<n>`)",
                        i + 1,
                        j + 1,
                        i + 1
                    ));
                };
                let name = cap(name.replace('.', " ").trim(), MAX_STRAND_NAME);
                if name.is_empty() {
                    return Err(format!("step {}: strand {} has no usable name", i + 1, j + 1));
                }
                if name.chars().all(|c| c.is_ascii_digit()) {
                    return Err(format!(
                        "step {}: a strand cannot be called {name:?} — a number in a path is \
                         read as a sub-step index. Give it a word.",
                        i + 1
                    ));
                }
                if names.iter().any(|n| n.eq_ignore_ascii_case(&name)) {
                    return Err(format!("step {}: two strands are called {name:?}", i + 1));
                }
                names.push(name.clone());
                let (subs, g) = subs_of(st.get("subs"))?;
                strands.push(Strand {
                    name: Some(name),
                    background: st.get("background").and_then(Value::as_bool).unwrap_or(false),
                    subs,
                });
                strand_given.push(g);
            }
            /* One strand named is still one line of work. Kept named so its
               paths do not change shape if the card adds a second later. */
        } else {
            let (subs, g) = subs_of(s.get("subs"))?;
            if !subs.is_empty() {
                strands.push(Strand { name: None, background: false, subs });
                strand_given.push(g);
            }
        }

        plan.steps.push(Step {
            title: cap(&title, MAX_STEP_TITLE),
            about,
            state,
            strands,
            marks: Marks::default(),
        });
        given.push((step_given, strand_given));
    }
    Ok((plan, given))
}

/// Fill in every state the caller did not write, from the plan being replaced.
///
/// Matched by title rather than by position, because the reason for calling
/// `set` again is usually that the plan changed shape — a step inserted, a
/// strand split off — and position is exactly what that moves. A step is found
/// by its title; inside it, a sub-step by its strand's name and its own title.
fn folded(name: Option<&str>) -> Option<String> {
    name.map(str::to_lowercase)
}

fn carry(new: &mut Plan, given: &Given, old: &Plan) {
    let same = |a: &str, b: &str| a.trim().eq_ignore_ascii_case(b.trim());
    for (step, (step_given, strand_given)) in new.steps.iter_mut().zip(given) {
        let Some(was) = old.steps.iter().find(|s| same(&s.title, &step.title)) else {
            continue;
        };
        step.marks.born = was.marks.born;
        if !*step_given {
            step.state = was.state;
        }
        for (strand, subs_given) in step.strands.iter_mut().zip(strand_given) {
            for (sub, g) in strand.subs.iter_mut().zip(subs_given) {
                /* Same strand first; then anywhere in the step, since a sub-step
                   moved into a new strand is still the same piece of work. */
                let found = was
                    .strands
                    .iter()
                    .filter(|s| folded(s.name.as_deref()) == folded(strand.name.as_deref()))
                    .flat_map(|s| s.subs.iter())
                    .find(|s| same(&s.title, &sub.title))
                    .or_else(|| was.subs().find(|s| same(&s.title, &sub.title)));
                if let Some(f) = found {
                    sub.marks.born = f.marks.born;
                    if !*g {
                        sub.state = f.state;
                    }
                    if sub.state == f.state {
                        sub.marks.done = f.marks.done;
                    }
                }
            }
        }
        /* After the sub-steps, since a step with any is exactly as done as
           they are: still done, and it keeps the write that finished it. */
        if step.effective() == State::Done && was.effective() == State::Done {
            step.marks.done = was.marks.done;
        }
    }
}

/// Take the next revision and stamp it on everything this write changed: an
/// item with no `born` was added by it, and an item that is done with no `done`
/// was finished by it. An item that is no longer done forgets when it was — a
/// rewind is a rewind, and the click should not carry anybody to a "done" that
/// was taken back.
///
/// `old` is the plan before the write, so a step whose state is derived from
/// its sub-steps is stamped exactly when the last of them lands.
fn stamp(plan: &mut Plan, old: Option<&Plan>) {
    plan.rev = old.map(|o| o.rev).unwrap_or(0) + 1;
    let rev = plan.rev;
    for step in plan.steps.iter_mut() {
        step.marks.born.get_or_insert(rev);
        for sub in step.strands.iter_mut().flat_map(|s| s.subs.iter_mut()) {
            sub.marks.born.get_or_insert(rev);
            if sub.state == State::Done {
                sub.marks.done.get_or_insert(rev);
            } else {
                sub.marks.done = None;
            }
        }
        if step.effective() == State::Done {
            step.marks.done.get_or_insert(rev);
        } else {
            step.marks.done = None;
        }
    }
}

/// The last line of every write's answer. Short, because it is paid for in
/// every one of them, and bracketed so the front end cannot mistake a revision
/// for a number in the plan's own text.
///
/// It carries the timeline as well as the revision: `rev` starts at 1 for
/// every timeline, and a card holding a complete one on the glass while it
/// draws the next has two `r3`s in one transcript. Six characters of the id are
/// enough to tell a card's own timelines apart, which is all it has to do.
fn receipt(id: &str, rev: u32) -> String {
    format!("[timeline {} r{rev}]", short(id))
}

fn short(id: &str) -> String {
    id.chars().filter(|c| *c != '-').take(6).collect()
}

/* ── paths ───────────────────────────────────────────────────────────────── */

/// What a path names: a whole step, or one sub-step in it.
#[derive(Debug, PartialEq)]
enum Target {
    Step(usize),
    Sub(usize, usize, usize),
}

/// `3`, `3.2`, `3.ui.2` → a target, or a sentence saying what was wrong.
///
/// 1-based throughout, because that is how the rendering numbers them and how
/// an agent reading it will count.
fn resolve(plan: &Plan, path: &str) -> Result<Target, String> {
    let parts: Vec<&str> = path.trim().split('.').map(str::trim).collect();
    let bad = || format!("{path:?} is not a path — use `3`, `3.2` or `3.<strand>.2`");
    let step_n: usize = parts.first().and_then(|p| p.parse().ok()).ok_or_else(bad)?;
    let Some(step) = step_n.checked_sub(1).and_then(|i| plan.steps.get(i)) else {
        return Err(format!("there is no step {step_n} — the plan has {}", plan.steps.len()));
    };
    let si = step_n - 1;
    match parts.len() {
        1 => Ok(Target::Step(si)),
        2 => {
            let n: usize = parts[1].parse().map_err(|_| {
                format!(
                    "{path:?}: name the sub-step by number — `{step_n}.{}.<n>` if you meant strand {:?}",
                    parts[1], parts[1]
                )
            })?;
            if step.strands.len() > 1 {
                return Err(format!(
                    "step {step_n} runs in strands ({}), so its sub-steps are addressed \
                     `{step_n}.<strand>.{n}`",
                    names(step)
                ));
            }
            let Some(strand) = step.strands.first() else {
                return Err(format!("step {step_n} has no sub-steps — mark it as `{step_n}`"));
            };
            let Some(_) = n.checked_sub(1).and_then(|i| strand.subs.get(i)) else {
                return Err(format!(
                    "step {step_n} has {} sub-steps, not {n}",
                    strand.subs.len()
                ));
            };
            Ok(Target::Sub(si, 0, n - 1))
        }
        3 => {
            let want = parts[1].to_lowercase();
            let Some(ki) = step
                .strands
                .iter()
                .position(|s| s.name.as_deref().map(str::to_lowercase).as_deref() == Some(want.as_str()))
            else {
                return Err(format!(
                    "step {step_n} has no strand {:?}{}",
                    parts[1],
                    if step.strands.iter().any(|s| s.name.is_some()) {
                        format!(" — it has {}", names(step))
                    } else {
                        String::new()
                    }
                ));
            };
            let n: usize = parts[2].parse().map_err(|_| bad())?;
            let strand = &step.strands[ki];
            let Some(_) = n.checked_sub(1).and_then(|i| strand.subs.get(i)) else {
                return Err(format!(
                    "strand {:?} of step {step_n} has {} sub-steps, not {n}",
                    parts[1],
                    strand.subs.len()
                ));
            };
            Ok(Target::Sub(si, ki, n - 1))
        }
        _ => Err(bad()),
    }
}

fn names(step: &Step) -> String {
    step.strands
        .iter()
        .filter_map(|s| s.name.as_deref())
        .collect::<Vec<_>>()
        .join(", ")
}

/// Apply one mark. A step marked `done` or `todo` takes every sub-step with
/// it, which is what "that whole step is finished" and "start that step over"
/// mean; `active` on a step that has sub-steps names nothing in particular and
/// is refused rather than guessed at.
fn apply(plan: &mut Plan, target: &Target, state: State) -> Result<(), String> {
    match *target {
        Target::Step(i) => {
            let step = &mut plan.steps[i];
            if step.has_subs() {
                if state == State::Active {
                    return Err(format!(
                        "step {} has sub-steps, so it is active when one of them is — mark \
                         the sub-step you are on",
                        i + 1
                    ));
                }
                for s in step.strands.iter_mut().flat_map(|s| s.subs.iter_mut()) {
                    s.state = state;
                }
            }
            step.state = state;
        }
        Target::Sub(i, k, j) => plan.steps[i].strands[k].subs[j].state = state,
    }
    Ok(())
}

/* ── rendering for an agent ──────────────────────────────────────────────── */

/// The plan as text, with the path of everything in it — the one thing an
/// agent must have to call `mark` correctly, so it is in every answer that
/// shows the plan.
fn render(t: &Row) -> String {
    let p = &t.plan;
    let done = p.steps.iter().filter(|s| s.effective() == State::Done).count();
    let mut out = format!(
        "{:?} — {}, {} ({done} of {} steps done)\n",
        t.title,
        t.state,
        whereabouts(p),
        p.steps.len()
    );
    for (i, step) in p.steps.iter().enumerate() {
        let n = i + 1;
        out.push_str(&format!("\n{n}  {} {}", step.effective().glyph(), step.title));
        if !step.about.is_empty() {
            out.push_str(&format!(" — {}", step.about));
        }
        for strand in &step.strands {
            if let Some(name) = &strand.name {
                out.push_str(&format!(
                    "\n   [{name}{}]",
                    if strand.background { ", background" } else { "" }
                ));
            }
            for (j, sub) in strand.subs.iter().enumerate() {
                let path = match &strand.name {
                    Some(name) => format!("{n}.{name}.{}", j + 1),
                    None => format!("{n}.{}", j + 1),
                };
                out.push_str(&format!("\n   {path}  {} {}", sub.state.glyph(), sub.title));
            }
        }
    }
    out
}

/* ── the tools ───────────────────────────────────────────────────────────── */

const SUB_SCHEMA: &str = "A sub-step: a short title string, or {\"title\", \"state\"} with \
                          state `todo` | `active` | `done`.";

pub fn read_schema() -> Value {
    json!({
        "name": READ_TOOL,
        "description":
            "Read a timeline: the plan a card has drawn on the wall for a long piece of \
             work, with every step's and sub-step's state and the path to mark it by. \
             With no `card`, your own. Name another card to see how far its work has got \
             without costing it a turn — useful for a card watching the children it \
             spawned. Only the owner can change a timeline.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "card": {
                    "type": "string",
                    "description": "Another card's handle or title. Omit for your own."
                }
            }
        }
    })
}

pub fn set_schema() -> Value {
    json!({
        "name": SET_TOOL,
        "description":
            "Put your plan on the wall as a timeline — a frise of major steps, each with \
             short sub-steps — or replace the plan of the one you already have. The user \
             sees it stuck to the top of the wall and watches it move as you mark \
             progress with `mcp__skein__timeline_mark`.\n\n\
             For planned work with several distinct stages: an epic, a multi-stage \
             refactor, a migration. NOT for a small task, a quick fix, or open-ended \
             experimenting with no clear plan — a timeline that is mostly guesses is \
             noise on somebody's wall.\n\n\
             A step whose work runs in parallel — a background task beside the main \
             line, or work split two ways — takes `strands` instead of `subs`, each \
             strand named and with its own sub-steps; they are drawn as lines forking \
             off the step and rejoining at the next. Keep `about` to a sentence: it is \
             a hover card, not a plan document.\n\n\
             Calling this again replaces the plan. Any item whose state you leave out \
             keeps the state it had, matched by title, so restructuring does not mean \
             restating progress. One live timeline per card.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": {
                    "type": "string",
                    "description": "What the whole piece of work is, in a few words. \
                                    Required the first time; omit to keep the current one."
                },
                "steps": {
                    "type": "array",
                    "description": "The major steps, in order.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "title": { "type": "string", "description": "A word or two." },
                            "about": {
                                "type": "string",
                                "description": "One short sentence, shown on hover."
                            },
                            "state": {
                                "type": "string",
                                "enum": ["todo", "active", "done"],
                                "description": "Only read for a step with no sub-steps."
                            },
                            "subs": {
                                "type": "array",
                                "description": SUB_SCHEMA,
                                "items": {}
                            },
                            "strands": {
                                "type": "array",
                                "description": "Instead of `subs`, when the step's work \
                                                runs in parallel.",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "name": { "type": "string" },
                                        "background": {
                                            "type": "boolean",
                                            "description": "This strand is a background task."
                                        },
                                        "subs": {
                                            "type": "array",
                                            "description": SUB_SCHEMA,
                                            "items": {}
                                        }
                                    },
                                    "required": ["name"]
                                }
                            }
                        },
                        "required": ["title"]
                    }
                }
            },
            "required": ["steps"]
        }
    })
}

pub fn mark_schema() -> Value {
    json!({
        "name": MARK_TOOL,
        "description":
            "Move your timeline along: set the state of steps and sub-steps by path. \
             Paths are 1-based — `3` is a whole step, `3.2` a sub-step, `3.ui.2` a \
             sub-step in strand `ui` — and every answer from `mcp__skein__timeline` or \
             `mcp__skein__timeline_set` lists them. Several items can be marked in one \
             call. Going back is allowed: mark something `todo` or `active` again when \
             the work turns out not to be finished.\n\n\
             Mark as you go, not at the end — the point is that the user can see where \
             the work is right now.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "done": { "type": "array", "items": { "type": "string" } },
                "active": { "type": "array", "items": { "type": "string" } },
                "todo": { "type": "array", "items": { "type": "string" } }
            }
        }
    })
}

pub fn complete_schema() -> Value {
    json!({
        "name": COMPLETE_TOOL,
        "description":
            "Declare your timeline finished. It stays on the wall, drawn complete, until \
             the user archives it. Anything not marked done stays as it is, so the record \
             is honest about what was skipped — mark the work done first if it was. After \
             this you may start a new timeline with `mcp__skein__timeline_set`.",
        "inputSchema": { "type": "object", "properties": {} }
    })
}

fn do_read(app: &AppHandle, caller: &str, args: &Value) -> String {
    let store = app.state::<Store>();
    let Ok(conn) = store.0.lock() else {
        return "the store is unavailable".into();
    };
    let (owner, name) = match text(args.get("card")) {
        None => (caller.to_string(), String::new()),
        Some(want) => {
            let rows = crate::store::roster(&conn, None).unwrap_or_default();
            match crate::relay::resolve(&rows, &want) {
                Ok(r) => (r.id.clone(), r.title.clone()),
                Err(e) => return e,
            }
        }
    };
    match latest_of(&conn, &owner) {
        Some(t) => {
            let mut out = render(&t);
            if t.archived_at.is_some() {
                out.push_str("\n\n(archived — no longer on the wall)");
            }
            out
        }
        None if owner == caller => "you have no timeline. Draw one with \
                                    `mcp__skein__timeline_set` when a piece of planned, \
                                    multi-stage work starts."
            .into(),
        None => format!("{name:?} has no timeline."),
    }
}

fn do_set(app: &AppHandle, caller: &str, args: &Value) -> String {
    let (mut plan, given) = match plan_of(args) {
        Ok(p) => p,
        Err(e) => return format!("{e}. Nothing was changed."),
    };
    let store = app.state::<Store>();
    let id = {
        let Ok(conn) = store.0.lock() else {
            return "the store is unavailable".into();
        };
        let now = crate::store::now();
        let me = crate::store::roster_one(&conn, caller);
        let source = me.as_ref().map(|r| r.title.clone()).unwrap_or_default();
        let session = crate::store::session_of(&conn, caller).and_then(|(_, s)| s);
        match live_of(&conn, caller) {
            Some(was) => {
                carry(&mut plan, &given, &was.plan);
                stamp(&mut plan, Some(&was.plan));
                let title = text(args.get("title"))
                    .map(|t| cap(&t, MAX_TITLE))
                    .unwrap_or(was.title.clone());
                let json = serde_json::to_string(&plan).unwrap_or_default();
                if let Err(e) = conn.execute(
                    "UPDATE timeline SET title = ?2, plan_json = ?3, updated_at = ?4,
                            source = CASE WHEN ?5 = '' THEN source ELSE ?5 END,
                            session_id = COALESCE(?6, session_id)
                      WHERE id = ?1",
                    params![was.id, title, json, now, source, session],
                ) {
                    return format!("could not write the timeline: {e}");
                }
                was.id
            }
            None => {
                let Some(title) = text(args.get("title")) else {
                    return "a new timeline needs a `title` — what the whole piece of work is"
                        .into();
                };
                let Some(me) = me else {
                    return "this card is not on the wall, so it has nowhere to draw a timeline"
                        .into();
                };
                let id = crate::store::uuid_v4();
                stamp(&mut plan, None);
                let json = serde_json::to_string(&plan).unwrap_or_default();
                if let Err(e) = conn.execute(
                    "INSERT INTO timeline (id, owner_id, session_id, cwd, project, source, title,
                                           plan_json, state, born_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'live', ?9, ?9)",
                    params![
                        id,
                        caller,
                        session,
                        me.cwd,
                        me.project,
                        me.title,
                        cap(&title, MAX_TITLE),
                        json,
                        now
                    ],
                ) {
                    return format!("could not write the timeline: {e}");
                }
                id
            }
        }
    };
    changed(app, &id);
    let conn = store.0.lock();
    let shown = conn.ok().and_then(|c| one(&c, &id)).map(|t| render(&t)).unwrap_or_default();
    format!(
        "it is on the wall.\n\n{shown}\n\nMark progress with `mcp__skein__timeline_mark` as the \
         work moves — the paths are the numbers above.\n{}",
        receipt(&id, plan.rev)
    )
}

fn do_mark(app: &AppHandle, caller: &str, args: &Value) -> String {
    let mut marks: Vec<(String, State)> = vec![];
    for (key, state) in [("todo", State::Todo), ("active", State::Active), ("done", State::Done)] {
        match args.get(key) {
            None | Some(Value::Null) => {}
            Some(Value::String(p)) => marks.push((p.clone(), state)),
            Some(Value::Array(ps)) => {
                for p in ps {
                    match p.as_str() {
                        Some(p) => marks.push((p.to_string(), state)),
                        None => return format!("`{key}` is a list of paths like \"3.2\""),
                    }
                }
            }
            Some(_) => return format!("`{key}` is a list of paths like \"3.2\""),
        }
    }
    if marks.is_empty() {
        return "nothing to mark — give paths under `done`, `active` or `todo`".into();
    }

    let store = app.state::<Store>();
    let (id, said) = {
        let Ok(conn) = store.0.lock() else {
            return "the store is unavailable".into();
        };
        let Some(mut t) = live_of(&conn, caller) else {
            return "you have no live timeline to mark. Draw one with \
                    `mcp__skein__timeline_set` first."
                .into();
        };
        /* All or nothing: resolve every path before applying any, so a typo in
           the third path does not leave the first two applied and the agent
           unsure which landed. */
        let mut resolved = vec![];
        for (path, state) in &marks {
            match resolve(&t.plan, path) {
                Ok(target) => resolved.push((target, *state)),
                Err(e) => return format!("{e}. Nothing was marked."),
            }
        }
        let before = t.plan.clone();
        for (target, state) in &resolved {
            if let Err(e) = apply(&mut t.plan, target, *state) {
                return format!("{e}. Nothing was marked.");
            }
        }
        /* Already so: no revision taken and nothing written, so the receipt
           chain only ever marks a write that moved something. */
        if t.plan == before {
            return format!(
                "nothing changed — those are already in that state. Still {}.",
                whereabouts(&t.plan)
            );
        }
        stamp(&mut t.plan, Some(&before));
        let json = serde_json::to_string(&t.plan).unwrap_or_default();
        if let Err(e) = conn.execute(
            "UPDATE timeline SET plan_json = ?2, updated_at = ?3 WHERE id = ?1",
            params![t.id, json, crate::store::now()],
        ) {
            return format!("could not write the timeline: {e}");
        }
        let all_done = t.plan.current().is_none();
        let mut said = format!("marked {}; now {}.", marks.len(), whereabouts(&t.plan));
        if all_done {
            said.push_str(
                " Every step is done — call `mcp__skein__timeline_complete` when the work \
                 really is finished.",
            );
        }
        said.push(' ');
        said.push_str(&receipt(&t.id, t.plan.rev));
        (t.id, said)
    };
    changed(app, &id);
    said
}

fn do_complete(app: &AppHandle, caller: &str) -> String {
    let store = app.state::<Store>();
    let (id, title, left, rev) = {
        let Ok(conn) = store.0.lock() else {
            return "the store is unavailable".into();
        };
        let Some(mut t) = live_of(&conn, caller) else {
            return "you have no live timeline to complete.".into();
        };
        let now = crate::store::now();
        let before = t.plan.clone();
        stamp(&mut t.plan, Some(&before));
        let json = serde_json::to_string(&t.plan).unwrap_or_default();
        if let Err(e) = conn.execute(
            "UPDATE timeline SET state = 'complete', plan_json = ?3, ended_at = ?2, updated_at = ?2
              WHERE id = ?1",
            params![t.id, now, json],
        ) {
            return format!("could not write the timeline: {e}");
        }
        let left = t
            .plan
            .steps
            .iter()
            .flat_map(|s| {
                if s.has_subs() {
                    s.subs().map(|x| x.state).collect::<Vec<_>>()
                } else {
                    vec![s.state]
                }
            })
            .filter(|s| *s != State::Done)
            .count();
        (t.id, t.title, left, t.plan.rev)
    };
    changed(app, &id);
    let said = if left == 0 {
        format!("{title:?} is complete. It stays on the wall until the user archives it.")
    } else {
        format!(
            "{title:?} is complete, with {left} item{} not marked done — they stay that way \
             in the record. It stays on the wall until the user archives it.",
            if left == 1 { "" } else { "s" }
        )
    };
    format!("{said} {}", receipt(&id, rev))
}

pub fn handle(app: &AppHandle, conversation_id: &str, tool: &str, args: &Value) -> Option<String> {
    match tool {
        READ_TOOL => Some(do_read(app, conversation_id, args)),
        SET_TOOL => Some(do_set(app, conversation_id, args)),
        MARK_TOOL => Some(do_mark(app, conversation_id, args)),
        COMPLETE_TOOL => Some(do_complete(app, conversation_id)),
        _ => None,
    }
}

/* ── the card going away ─────────────────────────────────────────────────── */

/// A card is leaving the wall: its live timeline goes to the archive, marked
/// as left where it stopped. Called from `close_conversation_record`, beside the
/// board's and the sink's own clearing, so there is one place a close tidies up.
///
/// Also called when a card is *cleared*: the agent that drew the plan is gone
/// even though the card stays, so a plan left live would be one nobody
/// remembers. The session is deliberately **not** re-read here — after a clear
/// it is already the new one, and "pick it back up" must adopt the conversation
/// that drew the plan, which is the one `set` recorded.
pub(crate) fn leave_for(app: &AppHandle, conversation_id: &str) {
    let Some(store) = app.try_state::<Store>() else { return };
    let id = {
        let Ok(conn) = store.0.lock() else { return };
        let Some(t) = live_of(&conn, conversation_id) else { return };
        let now = crate::store::now();
        if conn
            .execute(
                "UPDATE timeline SET state = 'left', archived_at = ?2, ended_at = ?2,
                        updated_at = ?2
                  WHERE id = ?1",
                params![t.id, now],
            )
            .is_err()
        {
            return;
        }
        t.id
    };
    changed(app, &id);
}

/* ── commands for the wall ───────────────────────────────────────────────── */

/// Everything on the glass: live and complete, not yet archived.
#[tauri::command]
pub fn read_timelines(store: tauri::State<'_, Store>) -> Result<Vec<Row>, String> {
    let conn = store.0.lock().map_err(|e| e.to_string())?;
    Ok(query(&conn, "archived_at IS NULL ORDER BY born_at", &[]))
}

/// The archive, newest first.
#[tauri::command]
pub fn archived_timelines(store: tauri::State<'_, Store>) -> Result<Vec<Row>, String> {
    let conn = store.0.lock().map_err(|e| e.to_string())?;
    Ok(query(&conn, "archived_at IS NOT NULL ORDER BY archived_at DESC", &[]))
}

/// The user's archive click. A live one archived by hand is recorded as left,
/// since that is what it is — work nobody declared finished.
#[tauri::command]
pub fn archive_timeline(app: AppHandle, id: String) -> Result<(), String> {
    {
        let store = app.state::<Store>();
        let conn = store.0.lock().map_err(|e| e.to_string())?;
        let now = crate::store::now();
        conn.execute(
            "UPDATE timeline
                SET archived_at = ?2,
                    state = CASE WHEN state = 'live' THEN 'left' ELSE state END,
                    ended_at = COALESCE(ended_at, ?2)
              WHERE id = ?1 AND archived_at IS NULL",
            params![id, now],
        )
        .map_err(|e| e.to_string())?;
    }
    changed(&app, &id);
    Ok(())
}

/// Where the user put it on the glass, or back into the stack with `None`.
#[tauri::command]
pub fn place_timeline(
    app: AppHandle,
    id: String,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<(), String> {
    {
        let store = app.state::<Store>();
        let conn = store.0.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE timeline SET glass_x = ?2, glass_y = ?3 WHERE id = ?1",
            params![id, x, y],
        )
        .map_err(|e| e.to_string())?;
    }
    changed(&app, &id);
    Ok(())
}

/// Pick a left timeline back up: it returns to the glass, live, owned by the
/// card that has just adopted the session which made it.
///
/// Refused if that card already has a live one, rather than silently making
/// two — the rule every write here keeps.
#[tauri::command]
pub fn resume_timeline(app: AppHandle, id: String, owner_id: String) -> Result<(), String> {
    {
        let store = app.state::<Store>();
        let conn = store.0.lock().map_err(|e| e.to_string())?;
        if let Some(t) = live_of(&conn, &owner_id) {
            if t.id != id {
                return Err(format!("that card already has a live timeline, {:?}", t.title));
            }
        }
        let n = conn
            .execute(
                "UPDATE timeline
                    SET owner_id = ?2, state = 'live', archived_at = NULL, ended_at = NULL,
                        updated_at = ?3
                  WHERE id = ?1 AND state = 'left'",
                params![id, owner_id, crate::store::now()],
            )
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("only a timeline left unfinished can be picked back up".into());
        }
    }
    changed(&app, &id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(v: Value) -> Plan {
        plan_of(&v).expect("a plan").0
    }

    fn sample() -> Plan {
        plan(json!({ "steps": [
            { "title": "survey", "subs": ["a", "b"] },
            { "title": "viewer", "strands": [
                { "name": "ui", "subs": ["counts", "toggles", "empty"] },
                { "name": "api", "background": true, "subs": ["endpoint", "cache"] }
            ]},
            { "title": "ship" }
        ]}))
    }

    #[test]
    fn paths_reach_steps_subs_and_strands() {
        let p = sample();
        assert_eq!(resolve(&p, "1"), Ok(Target::Step(0)));
        assert_eq!(resolve(&p, "1.2"), Ok(Target::Sub(0, 0, 1)));
        assert_eq!(resolve(&p, "2.api.2"), Ok(Target::Sub(1, 1, 1)));
        assert_eq!(resolve(&p, "2.UI.1"), Ok(Target::Sub(1, 0, 0)));
    }

    #[test]
    fn a_wrong_path_says_what_is_there() {
        let p = sample();
        assert!(resolve(&p, "9").unwrap_err().contains("3"));
        assert!(resolve(&p, "2.1").unwrap_err().contains("ui, api"));
        assert!(resolve(&p, "2.db.1").unwrap_err().contains("ui, api"));
        assert!(resolve(&p, "1.5").unwrap_err().contains("2 sub-steps"));
        assert!(resolve(&p, "3.1").unwrap_err().contains("mark it as `3`"));
        assert!(resolve(&p, "x").is_err());
    }

    #[test]
    fn a_step_marked_done_takes_its_subs_and_active_is_refused() {
        let mut p = sample();
        apply(&mut p, &Target::Step(1), State::Done).unwrap();
        assert!(p.steps[1].subs().all(|s| s.state == State::Done));
        assert_eq!(p.steps[1].effective(), State::Done);
        assert!(apply(&mut p, &Target::Step(1), State::Active).is_err());
        apply(&mut p, &Target::Step(2), State::Active).unwrap();
        assert_eq!(p.steps[2].effective(), State::Active);
    }

    #[test]
    fn progress_counts_an_active_item_as_half() {
        let mut p = sample();
        assert_eq!(p.fraction(), 0.0);
        apply(&mut p, &Target::Step(0), State::Done).unwrap();
        apply(&mut p, &Target::Sub(1, 0, 0), State::Active).unwrap();
        // 8 units: 2 done + one half.
        assert!((p.fraction() - 2.5 / 8.0).abs() < 1e-9);
        assert_eq!(p.current(), Some(2));
    }

    #[test]
    fn replacing_the_plan_keeps_progress_it_can_match() {
        let mut old = sample();
        apply(&mut old, &Target::Step(0), State::Done).unwrap();
        apply(&mut old, &Target::Sub(1, 1, 0), State::Done).unwrap();
        // A step inserted at the front, a sub-step moved between strands, and
        // one state written explicitly.
        let (mut new, given) = plan_of(&json!({ "steps": [
            { "title": "prep" },
            { "title": "Survey", "subs": ["a", { "title": "b", "state": "todo" }] },
            { "title": "viewer", "strands": [
                { "name": "ui", "subs": ["counts", "endpoint"] },
                { "name": "api", "subs": ["cache"] }
            ]}
        ]}))
        .unwrap();
        carry(&mut new, &given, &old);
        assert_eq!(new.steps[0].state, State::Todo);
        assert_eq!(new.steps[1].strands[0].subs[0].state, State::Done);
        assert_eq!(new.steps[1].strands[0].subs[1].state, State::Todo, "written wins");
        assert_eq!(new.steps[2].strands[0].subs[1].state, State::Done, "moved strands");
    }

    #[test]
    fn the_plan_is_refused_whole_rather_than_half_kept() {
        assert!(plan_of(&json!({ "steps": [] })).is_err());
        assert!(plan_of(&json!({ "steps": [{ "subs": ["a"] }] })).is_err());
        assert!(plan_of(&json!({ "steps": [{ "title": "x", "subs": ["a"], "strands": [] }] })).is_err());
        assert!(plan_of(&json!({ "steps": [{ "title": "x", "strands": [{ "subs": [] }] }] })).is_err());
        assert!(plan_of(&json!({ "steps": [{ "title": "x", "strands": [
            { "name": "a" }, { "name": "A" }
        ] }] }))
        .is_err());
        assert!(plan_of(&json!({ "steps": [{ "title": "x", "strands": [{ "name": "2" }] }] })).is_err());
        assert!(plan_of(&json!({ "steps": [{ "title": "x", "subs": [{ "title": "a", "state": "nope" }] }] })).is_err());
        let many: Vec<Value> = (0..=MAX_STEPS).map(|i| json!({ "title": format!("s{i}") })).collect();
        assert!(plan_of(&json!({ "steps": many })).is_err());
    }

    #[test]
    fn every_write_stamps_what_it_added_and_what_it_finished() {
        let mut p = sample();
        stamp(&mut p, None);
        assert_eq!(p.rev, 1);
        assert_eq!(p.steps[1].strands[1].subs[0].marks.born, Some(1));
        assert_eq!(p.steps[0].marks.done, None);

        let before = p.clone();
        apply(&mut p, &Target::Sub(0, 0, 0), State::Done).unwrap();
        stamp(&mut p, Some(&before));
        assert_eq!(p.steps[0].strands[0].subs[0].marks.done, Some(2));
        assert_eq!(p.steps[0].marks.done, None, "half a step is not a done step");

        let before = p.clone();
        apply(&mut p, &Target::Sub(0, 0, 1), State::Done).unwrap();
        stamp(&mut p, Some(&before));
        assert_eq!(p.steps[0].marks.done, Some(3), "done when its last sub-step lands");
        assert_eq!(p.steps[0].strands[0].subs[0].marks.done, Some(2), "earlier marks keep theirs");

        let before = p.clone();
        apply(&mut p, &Target::Sub(0, 0, 0), State::Todo).unwrap();
        stamp(&mut p, Some(&before));
        assert_eq!(p.steps[0].marks.done, None, "a rewind forgets");
        assert_eq!(p.steps[0].strands[0].subs[0].marks.done, None);
        assert_eq!(p.rev, 4);
    }

    #[test]
    fn a_replanned_item_keeps_when_it_was_born_and_finished() {
        let mut old = sample();
        stamp(&mut old, None);
        let before = old.clone();
        apply(&mut old, &Target::Step(0), State::Done).unwrap();
        stamp(&mut old, Some(&before));
        let (mut new, given) = plan_of(&json!({ "steps": [
            { "title": "survey", "subs": ["a", "b"] },
            { "title": "brand new" }
        ]}))
        .unwrap();
        carry(&mut new, &given, &old);
        stamp(&mut new, Some(&old));
        assert_eq!(new.rev, 3);
        assert_eq!(new.steps[0].marks.born, Some(1));
        assert_eq!(new.steps[0].marks.done, Some(2));
        assert_eq!(new.steps[0].strands[0].subs[1].marks.done, Some(2));
        assert_eq!(new.steps[1].marks.born, Some(3));
    }

    #[test]
    fn a_receipt_names_its_timeline_as_well_as_its_revision() {
        assert_eq!(receipt("3fa9c1d2-0000-4000-8000-000000000000", 7), "[timeline 3fa9c1 r7]");
        assert_ne!(receipt("aaaaaa11-x", 3), receipt("bbbbbb22-x", 3));
    }

    #[test]
    fn a_state_that_is_not_a_word_is_refused_not_dropped() {
        assert!(plan_of(&json!({ "steps": [{ "title": "x", "state": 5 }] })).is_err());
        assert!(plan_of(&json!({ "steps": [{ "title": "x", "subs": [{ "title": "a", "state": true }] }] })).is_err());
        assert!(plan_of(&json!({ "steps": [{ "title": "x", "state": null }] })).is_ok());
        let p = plan(json!({ "steps": [{ "title": "x", "strands": [{ "name": ".ui." }, { "name": "api" }] }] }));
        assert_eq!(p.steps[0].strands[0].name.as_deref(), Some("ui"));
    }

    #[test]
    fn the_rendering_carries_every_path_an_agent_can_mark() {
        let p = sample();
        let row = Row {
            id: "t".into(),
            owner_id: "c".into(),
            session_id: None,
            cwd: String::new(),
            project: String::new(),
            source: String::new(),
            title: "rollout".into(),
            plan: p,
            state: "live".into(),
            archived_at: None,
            glass_x: None,
            glass_y: None,
            born_at: 0,
            updated_at: 0,
            ended_at: None,
        };
        let r = render(&row);
        for path in ["1.1", "1.2", "2.ui.3", "2.api.2", "\n3 "] {
            assert!(r.contains(path), "{path} missing from:\n{r}");
        }
        assert!(r.contains("background"));
    }

    #[test]
    fn the_write_tools_say_what_a_timeline_is_not_for() {
        let s = set_schema();
        let d = s["description"].as_str().unwrap();
        assert!(d.contains("NOT for a small task"));
        assert!(d.contains("experimenting"));
        assert_eq!(s["name"], SET_TOOL);
        assert_eq!(read_schema()["name"], READ_TOOL);
        assert_eq!(mark_schema()["name"], MARK_TOOL);
        assert_eq!(complete_schema()["name"], COMPLETE_TOOL);
    }
}
