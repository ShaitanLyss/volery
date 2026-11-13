//! Models: a model at an effort, what it costs, and the balance between them.
//!
//! The design is `docs/MODELS.md`; `src/lib/benchmarks.ts` is the other half.
//! What lives here is everything that has to happen with no window open: the
//! source adapters, the fetch, the SQLite cache, the ranking, the frontier and
//! the `models` tool.
//!
//! ## The split, and why the arithmetic is on this side
//!
//! The panel and the deferred `models` tool answer the same question, and only
//! one of them can reach the front end: `ask.rs` serves a tool from Rust with
//! no webview involved, and it may be answering with the window closed. So the
//! profile score, the frontier and the runner-up are computed once, here, and
//! the panel draws what it is handed. The *definitions* — profiles, weights,
//! aliases, task tags — are in `benchmarks.ts`, and this file reads the very
//! same `model-profiles.json` rather than carrying a second copy.
//!
//! ## The sources, and what they owe
//!
//! **BenchLM** publishes the catalogue: `models.json` carries every model's
//! score for every benchmark it was run on, `benchmarks.json` says what each
//! benchmark is, `pricing.json` and `speed.json` carry price and throughput.
//! Read 2026-11-13; the four endpoints below answered 200 with 6.5 MB in
//! total. Its terms are CC BY-NC 4.0 — queries and internal analysis are fine,
//! commercial display or redistribution needs a licence — so nothing here
//! publishes BenchLM's data anywhere: it is read by this machine, cached in
//! this machine's database, and credited on the panel. `leaderboard.json` is
//! deliberately not fetched: its category scores are BenchLM's own composite,
//! and the whole point of this feature is showing the components rather than
//! an aggregate somebody else folded.
//!
//! **Artificial Analysis** is the optional second source. Its free tier is 100
//! requests a day with attribution, and — read 2026-11-13 — the documented
//! `/api/v2/language/models` is Pro-only; a free key gets `403` there while
//! `/api/v2/language/models/free` answers the free shape. So the free endpoint
//! is what this fetches, and a Pro key is simply answered in the free shape.
//! **It publishes no effort field** despite the design hoping it would; every
//! reading it yields is therefore `effort not stated`, which is the honest
//! answer and the one the panel shows.
//!
//! A source that cannot be read yields nothing. It never yields a guessed
//! number: a parse that does not find what it expects fails the source, leaves
//! the previous cache in place, and says so on the panel.
//!
//! ## Effort
//!
//! The unit is a model **at an effort**, and neither source states one. The
//! column exists, the readings carry `not-stated`, and the equivalence the
//! design warns about — comparing a low-effort run to a max-effort one as
//! though they were the same level — cannot happen because no reading claims a
//! level it was not told. The wall's own aliases carry the effort it would
//! spawn at (`benchmarks.ts::ALIASES`), which is a fact about the wall rather
//! than about a source.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};

use crate::store::Store;

pub const MODELS_TOOL: &str = "models";

/// The one file both languages read. Reweighting a profile is an edit here and
/// a recompile, not a second table kept in step by a test.
const PROFILES_JSON: &str = include_str!("../../src/lib/model-profiles.json");

/// The sources' allow-list. Nothing in this module fetches a URL that is not
/// one of these constants; there is no caller-supplied url anywhere.
const BENCHLM_MODELS: &str = "https://benchlm.ai/data/models.json";
const BENCHLM_BENCHMARKS: &str = "https://benchlm.ai/data/benchmarks.json";
const BENCHLM_PRICING: &str = "https://benchlm.ai/data/pricing.json";
const BENCHLM_SPEED: &str = "https://benchlm.ai/data/speed.json";
const AA_FREE: &str = "https://artificialanalysis.ai/api/v2/language/models/free";

const BENCHLM_ATTRIBUTION: &str = "Data from BenchLM.ai (CC BY-NC 4.0)";
const AA_ATTRIBUTION: &str = "Data from Artificial Analysis";

/// The day floor: one fetch per source per day, whoever asks. A panel left
/// open does not hammer anybody, and a tool asked twice in a minute answers
/// from the cache.
const FLOOR_MS: i64 = 86_400_000;

/// How a price is combined. Named on every surface that shows a price, because
/// reasoning tokens are most of what an effort changes and a price without its
/// basis is not the decision.
const PRICE_BASIS: &str = "per 1M blended 3:1";

/// How much of a profile a model must cover before it gets a score at all:
/// half the members, by count. Below that the remaining members are not a
/// rounding error, they are a different question — and answering it from one
/// benchmark would be the guess this file refuses. Coverage is reported on
/// every row whether it passes or not.
fn enough(present: usize, members: usize) -> bool {
    present > 0 && present * 2 >= members
}

// ── the profile table, read from the file the front end also reads ─────────

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct Table {
    version: i64,
    authored_on: String,
    profiles: Vec<Profile>,
}

#[derive(Deserialize, Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub label: String,
    pub note: String,
    pub default_for: Option<String>,
    pub order: String,
    pub members: Vec<Member>,
}

#[derive(Deserialize, Clone, Debug, Serialize)]
pub struct Member {
    pub benchmark: String,
    pub weight: f64,
}

fn table() -> &'static Table {
    use std::sync::OnceLock;
    static TABLE: OnceLock<Table> = OnceLock::new();
    TABLE.get_or_init(|| {
        serde_json::from_str(PROFILES_JSON).expect("model-profiles.json is authored by this repository")
    })
}

fn profile_of(id: Option<&str>) -> Result<Profile, String> {
    let table = table();
    match id {
        Some(id) if !id.trim().is_empty() => table
            .profiles
            .iter()
            .find(|p| p.id == id.trim())
            .cloned()
            .ok_or_else(|| {
                let ids: Vec<&str> = table.profiles.iter().map(|p| p.id.as_str()).collect();
                format!("there is no {:?} profile. They are: {}.", id.trim(), ids.join(", "))
            }),
        _ => Ok(profile_for_kind("project")),
    }
}

fn profile_for_kind(kind: &str) -> Profile {
    let table = table();
    table
        .profiles
        .iter()
        .find(|p| p.default_for.as_deref() == Some(kind))
        .cloned()
        .unwrap_or_else(|| table.profiles[0].clone())
}

/// A profile from a caller's own benchmark set: `["deepSwe", "sweVerified"]` or
/// `[{"benchmark": "deepSwe", "weight": 3}]`. Weights default to 1.
fn custom_profile(args: &Value) -> Result<Option<Profile>, String> {
    let Some(list) = args.get("benchmarks").and_then(Value::as_array) else {
        return Ok(None);
    };
    if list.is_empty() {
        return Ok(None);
    }
    let mut members = Vec::new();
    for row in list {
        match row {
            Value::String(s) if !s.trim().is_empty() => members.push(Member {
                benchmark: s.trim().to_string(),
                weight: 1.0,
            }),
            Value::Object(_) => {
                let key = row.get("benchmark").and_then(Value::as_str).unwrap_or("").trim();
                if key.is_empty() {
                    return Err("a benchmark in `benchmarks` has no `benchmark` name".into());
                }
                let weight = row.get("weight").and_then(Value::as_f64).unwrap_or(1.0);
                if !(weight > 0.0) {
                    return Err(format!("the weight for {key:?} has to be a positive number"));
                }
                members.push(Member { benchmark: key.to_string(), weight });
            }
            _ => return Err("each `benchmarks` entry is a name, or an object with a `benchmark` and a `weight`".into()),
        }
    }
    Ok(Some(Profile {
        id: "custom".into(),
        label: "a set you chose".into(),
        note: "the benchmarks and weights this call named".into(),
        default_for: None,
        order: "quality".into(),
        members,
    }))
}

// ── what the database holds ────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SourceState {
    pub id: String,
    pub label: String,
    pub attribution: String,
    pub url: String,
    pub on: bool,
    pub status: String,
    pub at: Option<String>,
    pub said: Option<String>,
    pub rows: i64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ModelRow {
    pub source: String,
    pub key: String,
    pub name: String,
    pub creator: String,
    pub context_window: Option<i64>,
    pub release: Option<String>,
    pub vision: Option<bool>,
    pub tool_use: Option<bool>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkDef {
    pub key: String,
    pub name: String,
    pub category: String,
    pub unit: String,
    pub source: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Reading {
    pub source: String,
    pub model: String,
    pub benchmark: String,
    pub score: Option<f64>,
    pub unit: String,
    pub effort: String,
    pub harness: Option<String>,
    pub published: Option<String>,
    pub vendor: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Component {
    pub benchmark: String,
    pub name: String,
    pub weight: f64,
    pub score: Option<f64>,
    pub unit: String,
    pub source: String,
    pub published: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub key: String,
    pub name: String,
    pub creator: String,
    pub effort: String,
    pub source: String,
    pub quality: Option<f64>,
    pub price: Option<f64>,
    pub price_basis: String,
    pub input: Option<f64>,
    pub output: Option<f64>,
    pub context_window: Option<i64>,
    pub vision: Option<bool>,
    pub tool_use: Option<bool>,
    pub efficient: bool,
    pub rank: Option<usize>,
    pub coverage: f64,
    pub components: Vec<Component>,
    pub missing: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Unplaceable {
    pub key: String,
    pub why: String,
}

struct Catalogue {
    sources: Vec<SourceState>,
    models: Vec<ModelRow>,
    defs: Vec<BenchmarkDef>,
    readings: Vec<Reading>,
}

// ── the schema rung's tables (created in store.rs::migrate_v76) ────────────

fn iso(ms: i64) -> Option<String> {
    if ms <= 0 {
        return None;
    }
    let secs = ms / 1000;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    Some(format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    ))
}

/// Howard Hinnant's `civil_from_days`, the standard branch-free conversion.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn read_sources(conn: &rusqlite::Connection) -> Vec<SourceState> {
    let mut out = vec![
        SourceState {
            id: "benchlm".into(),
            label: "BenchLM".into(),
            attribution: BENCHLM_ATTRIBUTION.into(),
            url: "https://benchlm.ai/data".into(),
            on: true,
            status: "never".into(),
            at: None,
            said: None,
            rows: 0,
        },
        SourceState {
            id: "artificial-analysis".into(),
            label: "Artificial Analysis".into(),
            attribution: AA_ATTRIBUTION.into(),
            url: "https://artificialanalysis.ai/data-api".into(),
            on: crate::creds::held("artificialanalysis"),
            status: "off".into(),
            at: None,
            said: Some("no key — enter one in the integrations panel to turn this source on".into()),
            rows: 0,
        },
    ];
    let Ok(mut stmt) = conn.prepare("SELECT id, at, status, said, rows FROM benchmark_source") else {
        return out;
    };
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, i64>(4)?,
            ))
        })
        .map(|it| it.filter_map(Result::ok).collect::<Vec<_>>())
        .unwrap_or_default();
    for (id, at, status, said, count) in rows {
        if let Some(state) = out.iter_mut().find(|s| s.id == id) {
            if state.on {
                state.at = iso(at);
                state.status = status;
                state.said = said;
                state.rows = count;
            }
        }
    }
    out
}

fn read_catalogue(conn: &rusqlite::Connection) -> Catalogue {
    let sources = read_sources(conn);

    let mut models = Vec::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT source, key, name, creator, context_window, release, vision, tool_use \
         FROM benchmark_model ORDER BY name",
    ) {
        if let Ok(rows) = stmt.query_map([], |r| {
            Ok(ModelRow {
                source: r.get(0)?,
                key: r.get(1)?,
                name: r.get(2)?,
                creator: r.get(3)?,
                context_window: r.get(4)?,
                release: r.get(5)?,
                vision: r.get::<_, Option<i64>>(6)?.map(|v| v != 0),
                tool_use: r.get::<_, Option<i64>>(7)?.map(|v| v != 0),
            })
        }) {
            models = rows.filter_map(Result::ok).collect();
        }
    }

    let mut defs = Vec::new();
    if let Ok(mut stmt) = conn.prepare("SELECT key, name, category, unit, source FROM benchmark_def ORDER BY name")
    {
        if let Ok(rows) = stmt.query_map([], |r| {
            Ok(BenchmarkDef {
                key: r.get(0)?,
                name: r.get(1)?,
                category: r.get(2)?,
                unit: r.get(3)?,
                source: r.get(4)?,
            })
        }) {
            defs = rows.filter_map(Result::ok).collect();
        }
    }

    let mut readings = Vec::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT source, model, benchmark, score, unit, effort, harness, published, vendor \
         FROM benchmark_reading",
    ) {
        if let Ok(rows) = stmt.query_map([], |r| {
            Ok(Reading {
                source: r.get(0)?,
                model: r.get(1)?,
                benchmark: r.get(2)?,
                score: r.get(3)?,
                unit: r.get(4)?,
                effort: r.get(5)?,
                harness: r.get(6)?,
                published: r.get(7)?,
                vendor: r.get::<_, i64>(8)? != 0,
            })
        }) {
            readings = rows.filter_map(Result::ok).collect();
        }
    }

    Catalogue { sources, models, defs, readings }
}

/// The previous reading is kept when a fetch fails, and this is where that is
/// decided: nothing is deleted unless a source has just been read successfully.
fn replace_source(
    conn: &rusqlite::Connection,
    id: &str,
    rows: &Normalized,
    at: i64,
) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| format!("transient: {e}"))?;
    tx.execute("DELETE FROM benchmark_model WHERE source = ?1", [id])
        .map_err(|e| format!("clearing models: {e}"))?;
    tx.execute("DELETE FROM benchmark_def WHERE source = ?1", [id])
        .map_err(|e| format!("clearing benchmarks: {e}"))?;
    tx.execute("DELETE FROM benchmark_reading WHERE source = ?1", [id])
        .map_err(|e| format!("clearing readings: {e}"))?;
    for m in &rows.models {
        tx.execute(
            "INSERT OR REPLACE INTO benchmark_model \
             (source, key, name, creator, context_window, release, vision, tool_use) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                id,
                m.key,
                m.name,
                m.creator,
                m.context_window,
                m.release,
                m.vision.map(|v| v as i64),
                m.tool_use.map(|v| v as i64)
            ],
        )
        .map_err(|e| format!("writing a model: {e}"))?;
    }
    for d in &rows.defs {
        tx.execute(
            "INSERT OR REPLACE INTO benchmark_def (source, key, name, category, unit) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![id, d.key, d.name, d.category, d.unit],
        )
        .map_err(|e| format!("writing a benchmark: {e}"))?;
    }
    for r in &rows.readings {
        tx.execute(
            "INSERT OR REPLACE INTO benchmark_reading \
             (source, model, benchmark, effort, score, unit, harness, published, vendor, fetched) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            rusqlite::params![
                id,
                r.model,
                r.benchmark,
                r.effort,
                r.score,
                r.unit,
                r.harness,
                r.published,
                r.vendor as i64,
                at
            ],
        )
        .map_err(|e| format!("writing a reading: {e}"))?;
    }
    tx.execute(
        "INSERT INTO benchmark_source (id, at, status, said, rows) VALUES (?1, ?2, 'ok', NULL, ?3) \
         ON CONFLICT(id) DO UPDATE SET at = ?2, status = 'ok', said = NULL, rows = ?3",
        rusqlite::params![id, at, rows.readings.len() as i64],
    )
    .map_err(|e| format!("stamping the source: {e}"))?;
    tx.commit().map_err(|e| format!("committing: {e}"))
}

fn note_failure(conn: &rusqlite::Connection, id: &str, said: &str) {
    let _ = conn.execute(
        "INSERT INTO benchmark_source (id, at, status, said, rows) VALUES (?1, 0, 'failed', ?2, 0) \
         ON CONFLICT(id) DO UPDATE SET status = 'failed', said = ?2",
        rusqlite::params![id, crate::clip::keep(said, 400).kept],
    );
}

// ── the normalizer, which is where a source either makes sense or does not ─

#[derive(Default, Clone, Debug)]
struct Normalized {
    models: Vec<ModelRow>,
    defs: Vec<BenchmarkDef>,
    readings: Vec<Reading>,
}

/// The unit a benchmark is measured in, decided once per benchmark across every
/// model that has a reading for it.
///
/// **A scale is inferred from the data, never from a hope.** BenchLM's per-model
/// `benchmarks` object mixes percentages with Elo ratings, dollars, turn counts
/// and token rates, and a value of 1862 quietly averaged into a 0-100 profile
/// would be a number nobody could explain. So anything that leaves 0..=100 is
/// its own scale and stays out of every profile; the ones that stay inside it
/// are the scores the profiles are allowed to name.
fn unit_for(key: &str, name: &str, format: Option<&str>, values: &[f64]) -> String {
    if key.starts_with("price:") {
        return "USD / 1M tokens".into();
    }
    if key == "speed:time-to-first-token" {
        return "s".into();
    }
    if key.starts_with("speed:") {
        return "tokens/s".into();
    }
    /* The **name** and the format are read differently, and that distinction
       was learned from DeepSWE: its name is a score and its *format* is the
       sentence "Pass@1 with confidence interval, cost, time, and token
       metadata", which mentions cost because the harness publishes it beside
       the score. Reading the format for "cost" made a 0-100 benchmark a price.
       So a unit word is taken from the name, and from the format only for the
       two scales a name often omits (a rating is a rating whatever it is
       called). */
    let name = name.to_lowercase();
    let format = format.unwrap_or("").to_lowercase();
    if name.contains("elo") || format.contains("elo") {
        return "Elo".into();
    }
    if name.contains("rating") || format.contains("rating") {
        return "rating".into();
    }
    if name.contains("cost") || name.contains("price") || name.contains("usd") {
        return "USD".into();
    }
    if name.contains("turns") {
        return "turns".into();
    }
    if name.contains("seconds") || name.contains("latency") {
        return "s".into();
    }
    let inside = values.iter().all(|v| v.is_finite() && *v >= 0.0 && *v <= 100.0);
    if inside && !values.is_empty() {
        "score (0-100)".into()
    } else {
        "source scale".into()
    }
}

fn num(v: &Value) -> Option<f64> {
    v.as_f64().filter(|n| n.is_finite())
}

/// BenchLM's three files into one set of rows.
///
/// `models.json` is the catalogue and the benchmark scores; `benchmarks.json`
/// says what each benchmark *is*; `pricing.json` and `speed.json` are the two
/// dimensions that are per model rather than per benchmark, carried as readings
/// of `price:*` and `speed:*` so that one table serves every surface.
fn normalize_benchlm(models: &Value, benchmarks: &Value, pricing: &Value, speed: &Value) -> Result<Normalized, String> {
    let items = models
        .get("items")
        .and_then(Value::as_array)
        .ok_or("models.json has no `items` array")?;
    if items.is_empty() {
        return Err("models.json answered with no models".into());
    }
    let published = models
        .get("generatedAt")
        .and_then(Value::as_str)
        .map(str::to_string);

    // What each benchmark is, from its own definitions file.
    let mut defs: HashMap<String, (String, String, Option<String>)> = HashMap::new();
    for b in benchmarks.get("items").and_then(Value::as_array).into_iter().flatten() {
        let Some(key) = b.get("benchmarkKey").and_then(Value::as_str) else { continue };
        let name = b.get("name").and_then(Value::as_str).unwrap_or(key).to_string();
        let category = b
            .get("capabilityCategory")
            .or_else(|| b.get("category"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let format = b.get("format").and_then(Value::as_str).map(str::to_string);
        defs.insert(key.to_string(), (name, category, format));
    }

    // Pass one: every numeric value, per benchmark, so a scale can be decided
    // from the whole of it rather than from the first model that happens to
    // have a reading.
    let mut per_benchmark: BTreeMap<String, Vec<f64>> = BTreeMap::new();
    for m in items {
        for block in m.get("benchmarks").and_then(Value::as_object).into_iter().flat_map(|o| o.values()) {
            for (key, value) in block.as_object().into_iter().flatten() {
                if let Some(n) = num(value) {
                    per_benchmark.entry(key.clone()).or_default().push(n);
                }
            }
        }
    }

    let mut out = Normalized::default();
    for (key, values) in &per_benchmark {
        let (name, category, format) = defs
            .get(key)
            .cloned()
            .unwrap_or_else(|| (key.clone(), String::new(), None));
        out.defs.push(BenchmarkDef {
            key: key.clone(),
            name: name.clone(),
            category: category.clone(),
            unit: unit_for(key, &name, format.as_deref(), values),
            source: "benchlm".into(),
        });
    }
    for (key, unit) in [
        ("price:input", "USD / 1M tokens"),
        ("price:output", "USD / 1M tokens"),
        ("speed:time-to-first-token", "s"),
    ] {
        out.defs.push(BenchmarkDef {
            key: key.into(),
            name: key.into(),
            category: "price".into(),
            unit: unit.into(),
            source: "benchlm".into(),
        });
    }
    out.defs.push(BenchmarkDef {
        key: "speed:tokens-per-second".into(),
        name: "speed:tokens-per-second".into(),
        category: "speed".into(),
        unit: "tokens/s".into(),
        source: "benchlm".into(),
    });

    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for m in items {
        let Some(slug) = m.get("canonicalModelKey").and_then(Value::as_str) else { continue };
        // A judge model is a harness component, not a candidate.
        if slug.starts_with("native-") || !seen.insert(slug.to_string()) {
            continue;
        }
        let name = m.get("model").and_then(Value::as_str).unwrap_or(slug).to_string();
        let creator = m.get("creator").and_then(Value::as_str).unwrap_or("").to_string();
        let context = m
            .get("contextWindowTokens")
            .and_then(Value::as_i64)
            .filter(|n| *n > 0);
        let release = m.get("releaseDate").and_then(Value::as_str).map(str::to_string);

        let mut vision = false;
        let mut tool_use = false;
        for (category, block) in m.get("benchmarks").and_then(Value::as_object).into_iter().flatten() {
            for (key, value) in block.as_object().into_iter().flatten() {
                let Some(score) = num(value) else { continue };
                let unit = out
                    .defs
                    .iter()
                    .find(|d| d.key == *key)
                    .map(|d| d.unit.clone())
                    .unwrap_or_else(|| "source scale".into());
                if category == "multimodalGrounded" {
                    vision = true;
                }
                if category == "agentic" {
                    tool_use = true;
                }
                out.readings.push(Reading {
                    source: "benchlm".into(),
                    model: slug.to_string(),
                    benchmark: key.clone(),
                    score: Some(score),
                    unit,
                    effort: "not-stated".into(),
                    harness: None,
                    published: published.clone(),
                    vendor: false,
                });
            }
        }
        out.models.push(ModelRow {
            source: "benchlm".into(),
            key: slug.to_string(),
            name,
            creator,
            context_window: context,
            release,
            vision: vision.then_some(true),
            tool_use: tool_use.then_some(true),
        });
    }

    // Price, as two readings rather than one blended number: the blend is
    // arithmetic over a stated basis, and keeping the halves means the surface
    // can show what it was made of.
    for p in pricing.get("items").and_then(Value::as_array).into_iter().flatten() {
        let Some(slug) = p.get("canonicalModelKey").and_then(Value::as_str) else { continue };
        if !out.models.iter().any(|m| m.key == slug) {
            continue;
        }
        let input = num(p.get("inputPrice").unwrap_or(&Value::Null));
        let output = num(p.get("outputPrice").unwrap_or(&Value::Null));
        // A zero price is how a self-hosted open-weight model is listed, and
        // it is not a list price: it would dominate every frontier and mean
        // "somebody else's electricity". Left as no price, which is the truth.
        let both_free = matches!((input, output), (Some(i), Some(o)) if i == 0.0 && o == 0.0);
        if both_free {
            continue;
        }
        for (key, value) in [("price:input", input), ("price:output", output)] {
            if let Some(score) = value {
                out.readings.push(Reading {
                    source: "benchlm".into(),
                    model: slug.to_string(),
                    benchmark: key.into(),
                    score: Some(score),
                    unit: "USD / 1M tokens".into(),
                    effort: "not-stated".into(),
                    harness: None,
                    published: p.get("note").and_then(Value::as_str).map(|s| s.to_string()).or(published.clone()),
                    vendor: false,
                });
            }
        }
    }

    for s in speed.get("items").and_then(Value::as_array).into_iter().flatten() {
        let Some(slug) = s.get("canonicalModelKey").and_then(Value::as_str) else { continue };
        if !out.models.iter().any(|m| m.key == slug) {
            continue;
        }
        let stamp = s.get("sourceUpdatedAt").and_then(Value::as_str).map(str::to_string);
        for (key, value) in [
            ("speed:tokens-per-second", num(s.get("tokensPerSecond").unwrap_or(&Value::Null))),
            ("speed:time-to-first-token", num(s.get("ttft").unwrap_or(&Value::Null))),
        ] {
            if let Some(score) = value {
                out.readings.push(Reading {
                    source: "benchlm".into(),
                    model: slug.to_string(),
                    benchmark: key.into(),
                    score: Some(score),
                    unit: if key == "speed:time-to-first-token" { "s".into() } else { "tokens/s".into() },
                    effort: "not-stated".into(),
                    harness: Some("Artificial Analysis measurement, aggregated by BenchLM".into()),
                    published: stamp.clone().or(published.clone()),
                    vendor: false,
                });
            }
        }
    }

    if out.readings.is_empty() {
        return Err("BenchLM's files parsed but carried no numeric readings".into());
    }
    Ok(out)
}

/// The free-shape Artificial Analysis answer into the same rows.
///
/// The index names are mapped to `aa:*` keys so a component can be shown as
/// its own benchmark rather than as "the API's fourth number". `null` means
/// *not measured*, and it stays absent rather than becoming a zero.
fn normalize_aa(answer: &Value) -> Result<Normalized, String> {
    let items = answer
        .get("data")
        .and_then(Value::as_array)
        .ok_or("the answer has no `data` array")?;
    if items.is_empty() {
        return Err("the answer carried no models".into());
    }
    let mut out = Normalized::default();
    let indices: [(&str, &str); 8] = [
        ("artificial_analysis_intelligence_index", "aa:intelligence"),
        ("artificial_analysis_coding_index", "aa:coding"),
        ("artificial_analysis_agentic_index", "aa:agentic"),
        ("artificial_analysis_finance_and_accounting_index", "aa:finance-and-accounting"),
        ("artificial_analysis_strategy_and_ops_index", "aa:strategy-and-ops"),
        ("artificial_analysis_legal_index", "aa:legal"),
        ("artificial_analysis_healthcare_and_medical_index", "aa:healthcare-and-medical"),
        ("artificial_analysis_engineering_index", "aa:engineering"),
    ];
    for (field, key) in indices {
        out.defs.push(BenchmarkDef {
            key: key.into(),
            name: field.replace("artificial_analysis_", "").replace('_', " "),
            category: "artificial analysis".into(),
            unit: "score (0-100)".into(),
            source: "artificial-analysis".into(),
        });
    }
    for (key, unit) in [("price:input", "USD / 1M tokens"), ("price:output", "USD / 1M tokens")] {
        out.defs.push(BenchmarkDef {
            key: key.into(),
            name: key.into(),
            category: "price".into(),
            unit: unit.into(),
            source: "artificial-analysis".into(),
        });
    }
    for (key, unit) in [
        ("speed:tokens-per-second", "tokens/s"),
        ("speed:time-to-first-token", "s"),
    ] {
        out.defs.push(BenchmarkDef {
            key: key.into(),
            name: key.into(),
            category: "speed".into(),
            unit: unit.into(),
            source: "artificial-analysis".into(),
        });
    }

    for m in items {
        let Some(slug) = m.get("slug").and_then(Value::as_str) else { continue };
        let name = m.get("name").and_then(Value::as_str).unwrap_or(slug).to_string();
        let creator = m
            .pointer("/model_creator/name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let release = m.get("release_date").and_then(Value::as_str).map(str::to_string);
        out.models.push(ModelRow {
            source: "artificial-analysis".into(),
            key: slug.to_string(),
            name,
            creator,
            // Omitted on the free tier, which is a fact about the answer
            // rather than about the model.
            context_window: None,
            release,
            vision: None,
            tool_use: None,
        });
        for (field, key) in indices {
            if let Some(score) = m.pointer(&format!("/evaluations/{field}")).and_then(num) {
                out.readings.push(Reading {
                    source: "artificial-analysis".into(),
                    model: slug.to_string(),
                    benchmark: key.into(),
                    score: Some(score),
                    unit: "score (0-100)".into(),
                    effort: "not-stated".into(),
                    harness: Some("Artificial Analysis' own index, free tier".into()),
                    published: None,
                    vendor: false,
                });
            }
        }
        for (field, key) in [("price_1m_input_tokens", "price:input"), ("price_1m_output_tokens", "price:output")] {
            if let Some(score) = m.pointer(&format!("/pricing/{field}")).and_then(num) {
                if score > 0.0 {
                    out.readings.push(Reading {
                        source: "artificial-analysis".into(),
                        model: slug.to_string(),
                        benchmark: key.into(),
                        score: Some(score),
                        unit: "USD / 1M tokens".into(),
                        effort: "not-stated".into(),
                        harness: None,
                        published: None,
                        vendor: false,
                    });
                }
            }
        }
        for (pointer, key, unit) in [
            ("/performance_v3/mean_output_tokens_per_second", "speed:tokens-per-second", "tokens/s"),
            ("/performance_v3/mean_time_to_first_token_seconds", "speed:time-to-first-token", "s"),
        ] {
            if let Some(score) = m.pointer(pointer).and_then(num) {
                out.readings.push(Reading {
                    source: "artificial-analysis".into(),
                    model: slug.to_string(),
                    benchmark: key.into(),
                    score: Some(score),
                    unit: unit.into(),
                    effort: "not-stated".into(),
                    harness: Some("Artificial Analysis measurement".into()),
                    published: None,
                    vendor: false,
                });
            }
        }
    }
    if out.readings.is_empty() {
        return Err("the answer parsed but carried no readings".into());
    }
    Ok(out)
}

// ── the fetch ──────────────────────────────────────────────────────────────

fn get(url: &str, key: Option<&str>) -> Result<Value, String> {
    let mut req = crate::forge::agent().get(url);
    if let Some(key) = key {
        req = req.set("x-api-key", key.trim());
    }
    match req.call() {
        Ok(res) => res
            .into_json::<Value>()
            .map_err(|e| format!("unreadable answer from {url}: {e}")),
        Err(ureq::Error::Status(code, res)) => Err(format!(
            "{url} answered {code}{}",
            trailing(res.into_string().unwrap_or_default())
        )),
        Err(e) => Err(format!("could not reach {url}: {e}")),
    }
}

/// The useful part of a refusal body, as a suffix or as nothing. The same two
/// shapes `creds.rs::trailing` reads, kept local so a source's error text does
/// not depend on a forge module.
fn trailing(body: String) -> String {
    let said = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| {
            v.get("message")
                .or_else(|| v.get("error"))
                .or_else(|| v.pointer("/errors/0/message"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_default();
    let said = said.lines().next().unwrap_or("").trim().to_string();
    if said.is_empty() {
        String::new()
    } else {
        format!(": {said}")
    }
}

fn fetch_benchlm() -> Result<Normalized, String> {
    let models = get(BENCHLM_MODELS, None)?;
    let benchmarks = get(BENCHLM_BENCHMARKS, None)?;
    let pricing = get(BENCHLM_PRICING, None)?;
    let speed = get(BENCHLM_SPEED, None)?;
    normalize_benchlm(&models, &benchmarks, &pricing, &speed)
}

fn fetch_aa() -> Result<Normalized, String> {
    let key = crate::creds::token("artificialanalysis")
        .ok_or("artificial analysis is turned off — no key stored")?;
    let answer = get(AA_FREE, Some(&key))?;
    normalize_aa(&answer)
}

/// One pass over every source that is due, on the calling thread. Public so the
/// command can run it inside `off_main` and so a test can drive one source.
pub fn refresh(conn: &rusqlite::Connection, force: bool) -> Vec<SourceState> {
    let before = read_sources(conn);
    let now = now_ms();
    let due = |id: &str| -> bool {
        if force {
            return true;
        }
        let state = before.iter().find(|s| s.id == id);
        match state {
            Some(s) if s.on => match s.at.as_deref().and_then(|a| parse_iso_ms(a)) {
                Some(at) => now - at > FLOOR_MS,
                None => true,
            },
            _ => false,
        }
    };

    if due("benchlm") {
        match fetch_benchlm() {
            Ok(rows) => {
                if let Err(e) = replace_source(conn, "benchlm", &rows, now) {
                    note_failure(conn, "benchlm", &e);
                }
            }
            Err(e) => note_failure(conn, "benchlm", &e),
        }
    }
    if due("artificial-analysis") {
        match fetch_aa() {
            Ok(rows) => {
                if let Err(e) = replace_source(conn, "artificial-analysis", &rows, now) {
                    note_failure(conn, "artificial-analysis", &e);
                }
            }
            Err(e) => note_failure(conn, "artificial-analysis", &e),
        }
    }
    read_sources(conn)
}

fn parse_iso_ms(s: &str) -> Option<i64> {
    // The only shape `iso` writes, and the only one the store holds.
    let b = s.as_bytes();
    if b.len() < 19 {
        return None;
    }
    let n = |from: usize, to: usize| s.get(from..to)?.parse::<i64>().ok();
    let (y, m, d) = (n(0, 4)?, n(5, 7)?, n(8, 10)?);
    let (hh, mm, ss) = (n(11, 13)?, n(14, 16)?, n(17, 19)?);
    let days = days_from_civil(y, m, d);
    Some((days * 86_400 + hh * 3600 + mm * 60 + ss) * 1000)
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

// ── the ranking, the frontier, and the answer both surfaces share ─────────

fn blended(input: Option<f64>, output: Option<f64>) -> Option<f64> {
    match (input, output) {
        (Some(i), Some(o)) => Some((3.0 * i + o) / 4.0),
        _ => None,
    }
}

/// One entry per model that has enough of the profile to be scored at all.
///
/// **Quality is a weighted mean of the members that have a reading**, with the
/// weights renormalised over what is present, and `coverage` says how much of
/// the profile that was. A member with no reading is named in `missing` rather
/// than treated as a zero: a model that was not run on a benchmark has not
/// failed it.
fn rank(cat: &Catalogue, profile: &Profile) -> Vec<Entry> {
    let total_weight: f64 = profile.members.iter().filter(|m| m.weight > 0.0).map(|m| m.weight).sum();

    // (model, benchmark) → the reading to use. A profile member is a BenchLM
    // key; when two sources both answer for it the independent one wins, and a
    // vendor claim is only used when it is all there is (and is marked).
    let mut by_model: HashMap<&str, BTreeMap<&str, &Reading>> = HashMap::new();
    for r in &cat.readings {
        if r.score.is_none() {
            continue;
        }
        let per = by_model.entry(r.model.as_str()).or_default();
        match per.get(r.benchmark.as_str()) {
            Some(existing) => {
                let better = (!r.vendor && existing.vendor) || (r.source == "artificial-analysis" && existing.source == "benchlm");
                if better {
                    per.insert(r.benchmark.as_str(), r);
                }
            }
            None => {
                per.insert(r.benchmark.as_str(), r);
            }
        }
    }

    let def_name = |key: &str| -> String {
        cat.defs
            .iter()
            .find(|d| d.key == key)
            .map(|d| d.name.clone())
            .unwrap_or_else(|| key.to_string())
    };

    let mut rows: Vec<Entry> = Vec::new();
    for model in &cat.models {
        let Some(per) = by_model.get(model.key.as_str()) else { continue };
        let mut components = Vec::new();
        let mut missing = Vec::new();
        let mut got = 0.0;
        let mut present = 0usize;
        for member in &profile.members {
            if member.weight <= 0.0 {
                continue;
            }
            match per.get(member.benchmark.as_str()) {
                Some(r) => {
                    got += member.weight * r.score.unwrap_or(0.0);
                    present += 1;
                    components.push(Component {
                        benchmark: member.benchmark.clone(),
                        name: def_name(&member.benchmark),
                        weight: member.weight / total_weight,
                        score: r.score,
                        unit: r.unit.clone(),
                        source: r.source.clone(),
                        published: r.published.clone(),
                    });
                }
                None => {
                    missing.push(member.benchmark.clone());
                    components.push(Component {
                        benchmark: member.benchmark.clone(),
                        name: def_name(&member.benchmark),
                        weight: member.weight / total_weight,
                        score: None,
                        unit: String::new(),
                        source: String::new(),
                        published: None,
                    });
                }
            }
        }
        let quality = if enough(present, profile.members.len()) && got > 0.0 {
            let present_weight: f64 = profile
                .members
                .iter()
                .filter(|m| m.weight > 0.0 && !missing.contains(&m.benchmark))
                .map(|m| m.weight)
                .sum();
            Some(got / present_weight)
        } else {
            None
        }.map(|q| (q * 100.0).round() / 100.0);

        let input = per.get("price:input").and_then(|r| r.score);
        let output = per.get("price:output").and_then(|r| r.score);
        let price = blended(input, output).map(|p| (p * 1000.0).round() / 1000.0);

        rows.push(Entry {
            key: model.key.clone(),
            name: model.name.clone(),
            creator: model.creator.clone(),
            effort: "not-stated".into(),
            source: model.source.clone(),
            quality,
            price,
            price_basis: PRICE_BASIS.into(),
            input,
            output,
            context_window: model.context_window,
            vision: model.vision,
            tool_use: model.tool_use,
            efficient: false,
            rank: None,
            coverage: if total_weight > 0.0 {
                let present_weight: f64 = profile
                    .members
                    .iter()
                    .filter(|m| m.weight > 0.0 && !missing.contains(&m.benchmark))
                    .map(|m| m.weight)
                    .sum();
                (present_weight / total_weight * 100.0).round() / 100.0
            } else {
                0.0
            },
            components,
            missing,
        });
    }

    // The frontier: an entry is efficient when nothing else gives at least as
    // much quality for no more money. Computed over what is *placeable*, and
    // the rest are reported as unplaceable rather than drawn at zero.
    let mut placeable: Vec<usize> = rows
        .iter()
        .enumerate()
        .filter(|(_, r)| r.quality.is_some() && r.price.is_some())
        .map(|(i, _)| i)
        .collect();
    placeable.sort_by(|a, b| {
        let pa = rows[*a].price.unwrap_or(f64::MAX);
        let pb = rows[*b].price.unwrap_or(f64::MAX);
        pa.partial_cmp(&pb).unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut best_quality = f64::NEG_INFINITY;
    for i in &placeable {
        let q = rows[*i].quality.unwrap_or(0.0);
        if q > best_quality + 1e-9 {
            rows[*i].efficient = true;
            best_quality = q;
        }
    }

    // Order: the profile says which side of the balance it ranks on.
    if profile.order == "cost" {
        rows.sort_by(|a, b| {
            let pa = a.price.unwrap_or(f64::MAX);
            let pb = b.price.unwrap_or(f64::MAX);
            pa.partial_cmp(&pb)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(b.quality.unwrap_or(-1.0).partial_cmp(&a.quality.unwrap_or(-1.0)).unwrap_or(std::cmp::Ordering::Equal))
        });
    } else {
        rows.sort_by(|a, b| {
            b.quality
                .unwrap_or(-1.0)
                .partial_cmp(&a.quality.unwrap_or(-1.0))
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(a.price.unwrap_or(f64::MAX).partial_cmp(&b.price.unwrap_or(f64::MAX)).unwrap_or(std::cmp::Ordering::Equal))
        });
    }
    let mut placed = 0;
    for row in rows.iter_mut() {
        if row.quality.is_some() {
            placed += 1;
            row.rank = Some(placed);
        }
    }
    rows
}

/// The name of the efficient entry that dominates this one, for the quiet line
/// that says what a dimmed row lost to. Null when nothing dominates it (it is
/// efficient) or when it cannot be placed at all.
fn dominated_by(rows: &[Entry], i: usize) -> Option<String> {
    let a = &rows[i];
    let (Some(q), Some(p)) = (a.quality, a.price) else { return None };
    if a.efficient {
        return None;
    }
    rows.iter()
        .find(|b| b.efficient && b.price.unwrap_or(f64::MAX) <= p + 1e-9 && b.quality.unwrap_or(-1.0) >= q - 1e-9)
        .map(|b| b.name.clone())
}

fn needs_of(args: &Value) -> Value {
    args.get("needs").cloned().unwrap_or(Value::Null)
}

fn fits(row: &Entry, needs: &Value) -> bool {
    let at = |key: &str| needs.get(key);
    if at("vision").and_then(Value::as_bool) == Some(true) && row.vision != Some(true) {
        return false;
    }
    if at("toolUse").and_then(Value::as_bool) == Some(true) && row.tool_use != Some(true) {
        return false;
    }
    if let Some(floor) = at("context").and_then(Value::as_i64) {
        if row.context_window.map_or(true, |c| c < floor) {
            return false;
        }
    }
    if let Some(ceiling) = at("maxPrice").and_then(Value::as_f64) {
        if row.price.map_or(true, |p| p > ceiling + 1e-9) {
            return false;
        }
    }
    true
}

fn view(conn: &rusqlite::Connection, profile: &Profile) -> Value {
    let cat = read_catalogue(conn);
    let rows = rank(&cat, profile);
    let as_of = cat
        .sources
        .iter()
        .filter(|s| s.on)
        .filter_map(|s| s.at.as_deref().and_then(parse_iso_ms))
        .max()
        .and_then(iso);
    let unplaceable: Vec<Unplaceable> = rows
        .iter()
        .filter(|r| !r.efficient && r.quality.is_some() && r.price.is_none())
        .map(|r| Unplaceable {
            key: r.key.clone(),
            why: "no price published".into(),
        })
        .collect();
    let domination: Vec<Value> = rows
        .iter()
        .enumerate()
        .filter_map(|(i, r)| dominated_by(&rows, i).map(|by| json!({ "key": r.key, "by": by })))
        .collect();

    json!({
        "profile": profile,
        "profileVersion": table().version,
        "authoredOn": table().authored_on,
        "asOf": as_of,
        "sources": cat.sources,
        "rows": rows,
        "unplaceable": unplaceable,
        "dominated": domination,
        "priceBasis": PRICE_BASIS,
    })
}

fn catalogue_answer(conn: &rusqlite::Connection, benchmark: Option<&str>, model: Option<&str>) -> Value {
    let cat = read_catalogue(conn);
    let readings: Vec<&Reading> = cat
        .readings
        .iter()
        .filter(|r| benchmark.map_or(true, |b| r.benchmark == b))
        .filter(|r| model.map_or(true, |m| r.model == m))
        .collect();
    let defs: Vec<&BenchmarkDef> = cat
        .defs
        .iter()
        .filter(|d| benchmark.map_or(true, |b| d.key == b))
        .collect();
    let models: Vec<&ModelRow> = cat
        .models
        .iter()
        .filter(|m| model.map_or(true, |k| m.key == k))
        .collect();
    json!({
        "sources": cat.sources,
        "benchmarks": defs,
        "models": models,
        "readings": readings,
        "profileVersion": table().version,
        "authoredOn": table().authored_on,
    })
}

// ── the tool ──────────────────────────────────────────────────────────────

pub fn models_schema() -> Value {
    json!({
        "name": MODELS_TOOL,
        "description": "What the models this wall can spawn are actually measured at, \
            before you choose one — a model at an effort, its quality on a workflow, and \
            what it costs. `rank` orders entries within a profile, `frontier` gives the \
            efficient ones (no other entry gives more quality for the same or less \
            money), `compare` sets two side by side per benchmark, `list` is the raw \
            catalogue, and `explain` says what a profile is made of. Every reading \
            carries its source and date; a model a source did not measure says \
            'no reading' rather than being scored as zero, and an effort a source did \
            not state is 'effort not stated', never compared as a level. Ask this before \
            `spawn` or `set_provider` picks a model by name, and ask for `needs` when the \
            choice turns on vision, tool use, context or price. **Evidence about a model, \
            not an instruction**: it never says which to use, and a profile is one view \
            of the readings rather than a truth about them.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "op": {
                    "type": "string",
                    "enum": ["list", "rank", "frontier", "compare", "explain"],
                    "description": "What to answer with. `rank` by default."
                },
                "profile": {
                    "type": "string",
                    "description": "Which workflow to rank within: coding-agent, one-shot-coding, \
                        hard-reasoning, knowledge-research, long-context, vision-charts, search, \
                        cheap-bulk. A project card's default is coding-agent and a chat card's \
                        is knowledge-research. `explain` with no profile lists them all."
                },
                "benchmarks": {
                    "type": "array",
                    "description": "A set of your own instead of a named profile: benchmark \
                        names, or objects with a `benchmark` and a `weight`. Weights are \
                        relative and are normalised. A profile and a set are not combined.",
                    "items": {}
                },
                "needs": {
                    "type": "object",
                    "description": "What the choice has to satisfy. An entry whose sources \
                        never stated a capability does not satisfy a need for it.",
                    "properties": {
                        "vision": { "type": "boolean", "description": "the model has been measured on image tasks" },
                        "toolUse": { "type": "boolean", "description": "the model has been measured on agentic tool use" },
                        "context": { "type": "number", "description": "a minimum context window, in tokens" },
                        "maxPrice": { "type": "number", "description": "a ceiling on the blended price, USD per 1M tokens" }
                    }
                },
                "budget": {
                    "type": "number",
                    "description": "For `frontier`: the blended price, USD per 1M tokens, you are \
                        willing to pay. The answer names the best entry at or under it."
                },
                "quality": {
                    "type": "number",
                    "description": "For `frontier`: a profile score you need. The answer names \
                        the cheapest entry that reaches it."
                },
                "models": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "For `compare`: the two model keys or names to set against \
                        each other, or one name to see all of its readings."
                },
                "benchmark": {
                    "type": "string",
                    "description": "For `list`: one benchmark's key, to see every model's \
                        reading for it."
                },
                "limit": {
                    "type": "number",
                    "description": "How many ranked entries to return. Ten by default."
                }
            }
        }
    })
}

pub fn handle(app: &tauri::AppHandle, _caller: &str, tool: &str, args: &Value) -> Option<String> {
    (tool == MODELS_TOOL).then(|| answer(app, args))
}

fn answer(app: &tauri::AppHandle, args: &Value) -> String {
    use tauri::Manager;
    let Some(store) = app.try_state::<Store>() else {
        return "the store is unavailable".into();
    };
    let op = args.get("op").and_then(Value::as_str).unwrap_or("rank").trim();
    let profile = match custom_profile(args) {
        Ok(Some(p)) => p,
        Ok(None) => match profile_of(args.get("profile").and_then(Value::as_str)) {
            Ok(p) => p,
            Err(e) => return e,
        },
        Err(e) => return e,
    };
    let limit = args
        .get("limit")
        .and_then(Value::as_u64)
        .map(|n| n.clamp(1, 50) as usize)
        .unwrap_or(10);
    let needs = needs_of(args);

    let conn = store.0.lock().unwrap_or_else(|e| e.into_inner());
    // A tool call is one of the two events that refreshes the cache, and the
    // floor is what stops it from being a fetch per turn.
    let sources = refresh(&conn, false);
    let as_of = sources
        .iter()
        .filter(|s| s.on)
        .filter_map(|s| s.at.as_deref().and_then(parse_iso_ms))
        .max()
        .and_then(iso);

    match op {
        "explain" => {
            let profiles: Vec<Value> = if args.get("profile").and_then(Value::as_str).is_none() {
                table().profiles.iter().map(|p| json!(p)).collect()
            } else {
                vec![json!(profile)]
            };
            let defs: Vec<Value> = table()
                .profiles
                .iter()
                .flat_map(|p| p.members.iter().map(|m| m.benchmark.clone()))
                .collect::<std::collections::BTreeSet<_>>()
                .into_iter()
                .map(|key| {
                    let d = read_catalogue(&conn).defs.into_iter().find(|d| d.key == key);
                    json!({
                        "benchmark": key,
                        "name": d.as_ref().map(|d| d.name.clone()).unwrap_or_else(|| key.clone()),
                        "category": d.as_ref().map(|d| d.category.clone()).unwrap_or_default(),
                        "unit": d.as_ref().map(|d| d.unit.clone()).unwrap_or_else(|| "no reading".into()),
                    })
                })
                .collect();
            json!({
                "profiles": profiles,
                "benchmarks": defs,
                "priceBasis": PRICE_BASIS,
                "efforts": {
                    "levels": ["low", "medium", "high", "xhigh", "max"],
                    "none": "the model takes no effort parameter",
                    "notStated": "the source did not say what effort it ran at; never treated as a level",
                },
                "sources": sources,
                "asOf": as_of,
                "note": "A profile is a weighted view of benchmarks, not a truth about a model. \
                    Quality is the weighted mean of the members that have a reading, with the \
                    weights renormalised over what is present and coverage reported; a member \
                    with no reading is named rather than scored as zero.",
            })
            .to_string()
        }
        "compare" => {
            let wanted: Vec<String> = args
                .get("models")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
                .unwrap_or_default();
            let cat = read_catalogue(&conn);
            let rows = rank(&cat, &profile);
            let picked: Vec<&Entry> = rows
                .iter()
                .filter(|r| {
                    wanted.is_empty()
                        || wanted.iter().any(|w| {
                            let w = w.to_lowercase();
                            r.key.to_lowercase() == w || r.name.to_lowercase() == w || r.name.to_lowercase().contains(&w)
                        })
                })
                .collect();
            if picked.is_empty() {
                return format!(
                    "no entry here matches {}. Ask `mcp__skein__models` with `op: list` for the names this \
                     wall has a reading for.",
                    if wanted.is_empty() { "anything".to_string() } else { wanted.join(", ") }
                );
            }
            let rows: Vec<Value> = picked
                .iter()
                .take(2)
                .map(|r| {
                    json!({
                        "key": r.key,
                        "name": r.name,
                        "creator": r.creator,
                        "effort": r.effort,
                        "quality": r.quality,
                        "coverage": r.coverage,
                        "price": r.price,
                        "priceBasis": r.price_basis,
                        "input": r.input,
                        "output": r.output,
                        "contextWindow": r.context_window,
                        "vision": r.vision,
                        "toolUse": r.tool_use,
                        "components": r.components,
                        "missing": r.missing,
                    })
                })
                .collect();
            let difference = if picked.len() >= 2 {
                match (picked[0].quality, picked[1].quality, picked[0].price, picked[1].price) {
                    (Some(qa), Some(qb), pa, pb) => json!({
                        "quality": ((qa - qb) * 100.0).round() / 100.0,
                        "price": match (pa, pb) { (Some(a), Some(b)) => json!(((a - b) * 1000.0).round() / 1000.0), _ => Value::Null },
                        "note": "quality is the first entry minus the second; price likewise",
                    }),
                    _ => json!({ "note": "one of the two has no score, so there is no difference to state" }),
                }
            } else {
                Value::Null
            };
            json!({
                "profile": profile.label,
                "entries": rows,
                "difference": difference,
                "priceBasis": PRICE_BASIS,
                "sources": sources,
                "asOf": as_of,
            })
            .to_string()
        }
        "list" => {
            let benchmark = args.get("benchmark").and_then(Value::as_str);
            let model = args.get("models").and_then(Value::as_array).and_then(|a| a.first()).and_then(Value::as_str);
            let mut answer = catalogue_answer(&conn, benchmark, model);
            answer["op"] = json!("list");
            answer["asOf"] = json!(as_of);
            answer.to_string()
        }
        _ => {
            let ranked = view(&conn, &profile);
            let all: Vec<Entry> = serde_json::from_value(ranked["rows"].clone()).unwrap_or_default();
            let filtered: Vec<&Entry> = all.iter().filter(|r| fits(r, &needs)).collect();
            let op = if op == "frontier" { "frontier" } else { "rank" };
            let mut shown: Vec<Value> = Vec::new();
            let mut pick: Option<Value> = None;
            let budget = args.get("budget").and_then(Value::as_f64);
            let quality = args.get("quality").and_then(Value::as_f64);
            if op == "frontier" {
                let efficient: Vec<&&Entry> = filtered.iter().filter(|r| r.efficient).collect();
                if let Some(ceiling) = budget {
                    if let Some(best) = efficient
                        .iter()
                        .filter(|r| r.price.map_or(false, |p| p <= ceiling + 1e-9))
                        .max_by(|a, b| a.quality.unwrap_or(0.0).partial_cmp(&b.quality.unwrap_or(0.0)).unwrap_or(std::cmp::Ordering::Equal))
                    {
                        pick = Some(json!({
                            "key": best.key, "name": best.name, "quality": best.quality,
                            "price": best.price, "priceBasis": best.price_basis,
                            "why": format!("the best quality on the frontier at or under ${ceiling} per 1M blended"),
                        }));
                    } else {
                        pick = Some(json!({"why": format!("nothing on the frontier is at or under ${ceiling} per 1M blended")}));
                    }
                } else if let Some(target) = quality {
                    if let Some(cheapest) = efficient
                        .iter()
                        .filter(|r| r.quality.map_or(false, |q| q >= target - 1e-9))
                        .min_by(|a, b| a.price.unwrap_or(f64::MAX).partial_cmp(&b.price.unwrap_or(f64::MAX)).unwrap_or(std::cmp::Ordering::Equal))
                    {
                        pick = Some(json!({
                            "key": cheapest.key, "name": cheapest.name, "quality": cheapest.quality,
                            "price": cheapest.price, "priceBasis": cheapest.price_basis,
                            "why": format!("the cheapest entry on the frontier that reaches {target}"),
                        }));
                    } else {
                        pick = Some(json!({"why": format!("nothing on the frontier reaches {target}")}));
                    }
                }
                for r in efficient.iter().take(limit) {
                    shown.push(entry_json(r));
                }
            } else {
                for r in filtered.iter().take(limit) {
                    shown.push(entry_json(r));
                }
            }
            let runner_up = filtered
                .iter()
                .filter(|r| r.quality.is_some())
                .nth(1)
                .and_then(|r| {
                    let first = filtered.iter().find(|x| x.quality.is_some())?;
                    Some(json!({
                        "name": r.name,
                        "quality": r.quality,
                        "price": r.price,
                        "priceDifference": match (first.price, r.price) {
                            (Some(a), Some(b)) => json!(((a - b) * 1000.0).round() / 1000.0),
                            _ => Value::Null,
                        },
                        "note": "price is the first entry minus the runner-up, per 1M blended tokens",
                    }))
                });
            json!({
                "op": op,
                "profile": { "id": profile.id, "label": profile.label, "order": profile.order,
                             "members": profile.members, "note": profile.note },
                "entries": shown,
                "pick": pick,
                "runnerUp": runner_up,
                "needs": needs,
                "asOf": as_of,
                "sources": sources,
                "priceBasis": PRICE_BASIS,
                "note": "Evidence, not an instruction. A model with no reading was not measured \
                    by these sources; it did not score zero. Check `components` and `coverage` \
                    before drawing a conclusion from a single number.",
            })
            .to_string()
        }
    }
}

fn entry_json(r: &Entry) -> Value {
    json!({
        "key": r.key,
        "name": r.name,
        "creator": r.creator,
        "effort": r.effort,
        "quality": r.quality,
        "rank": r.rank,
        "coverage": r.coverage,
        "price": r.price,
        "priceBasis": r.price_basis,
        "input": r.input,
        "output": r.output,
        "contextWindow": r.context_window,
        "vision": r.vision,
        "toolUse": r.tool_use,
        "efficient": r.efficient,
        "components": r.components,
        "missing": r.missing,
    })
}

// ── the commands ──────────────────────────────────────────────────────────

/// The panel's first view: the ranked and frontier-scored entries for a profile.
/// Fetches first when the cache is past the day floor, which is the second of
/// the design's two refresh events (the other is the panel opening, which is
/// this same command).
#[tauri::command]
pub async fn models_view(app: tauri::AppHandle, profile: Option<String>) -> Result<Value, String> {
    let wanted = profile;
    crate::off_main(move || -> Result<Value, String> {
        use tauri::Manager;
        let store = app.state::<Store>();
        let conn = store.0.lock().unwrap_or_else(|e| e.into_inner());
        refresh(&conn, false);
        let p = profile_of(wanted.as_deref())?;
        Ok(view(&conn, &p))
    })
    .await?
}

#[tauri::command]
pub async fn models_catalogue(
    app: tauri::AppHandle,
    benchmark: Option<String>,
    model: Option<String>,
) -> Result<Value, String> {
    crate::off_main(move || -> Result<Value, String> {
        use tauri::Manager;
        let store = app.state::<Store>();
        let conn = store.0.lock().unwrap_or_else(|e| e.into_inner());
        Ok(catalogue_answer(&conn, benchmark.as_deref(), model.as_deref()))
    })
    .await?
}

/// The manual refresh. Always a real fetch, whatever the floor says.
#[tauri::command]
pub async fn models_refresh(app: tauri::AppHandle) -> Result<Value, String> {
    crate::off_main(move || -> Result<Value, String> {
        use tauri::Manager;
        let store = app.state::<Store>();
        let conn = store.0.lock().unwrap_or_else(|e| e.into_inner());
        let sources = refresh(&conn, true);
        Ok(json!({ "sources": sources }))
    })
    .await?
}

/// What each source has to say about itself, asked without fetching.
#[tauri::command]
pub async fn models_sources(app: tauri::AppHandle) -> Result<Value, String> {
    crate::off_main(move || -> Result<Value, String> {
        use tauri::Manager;
        let store = app.state::<Store>();
        let conn = store.0.lock().unwrap_or_else(|e| e.into_inner());
        let sources = read_sources(&conn);
        let as_of = sources
            .iter()
            .filter(|s| s.on)
            .filter_map(|s| s.at.as_deref().and_then(parse_iso_ms))
            .max()
            .and_then(iso);
        Ok(json!({ "sources": sources, "asOf": as_of, "profileVersion": table().version }))
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> Value {
        let text = match name {
            "models" => include_str!("../../test/fixtures/benchlm-models.json"),
            "benchmarks" => include_str!("../../test/fixtures/benchlm-benchmarks.json"),
            "pricing" => include_str!("../../test/fixtures/benchlm-pricing.json"),
            "speed" => include_str!("../../test/fixtures/benchlm-speed.json"),
            "aa" => include_str!("../../test/fixtures/aa-free.json"),
            other => panic!("no fixture {other}"),
        };
        serde_json::from_str(text).expect("the fixture is json")
    }

    fn benchlm() -> Normalized {
        normalize_benchlm(
            &fixture("models"),
            &fixture("benchmarks"),
            &fixture("pricing"),
            &fixture("speed"),
        )
        .expect("the fixtures normalize")
    }

    #[test]
    fn the_profiles_are_the_ones_the_front_end_reads() {
        let t = table();
        assert_eq!(t.version, 1);
        assert_eq!(t.profiles.len(), 8);
        let ids: Vec<&str> = t.profiles.iter().map(|p| p.id.as_str()).collect();
        assert!(ids.contains(&"coding-agent"));
        assert!(ids.contains(&"knowledge-research"));
        let project = profile_for_kind("project");
        let chat = profile_for_kind("chat");
        assert_eq!(project.id, "coding-agent");
        assert_eq!(chat.id, "knowledge-research");
        assert_ne!(project.id, chat.id);
    }

    #[test]
    fn an_unknown_profile_names_the_ones_that_exist() {
        let err = profile_of(Some("nope")).unwrap_err();
        assert!(err.contains("coding-agent"), "{err}");
    }

    #[test]
    fn benchlm_models_become_rows_and_every_reading_names_its_source() {
        let rows = benchlm();
        assert!(rows.models.iter().any(|m| m.key == "claude-sonnet-5-5"));
        assert!(rows.readings.iter().all(|r| r.source == "benchlm"));
        assert!(rows.readings.iter().all(|r| r.effort == "not-stated"));
        assert!(rows.readings.iter().any(|r| r.benchmark == "deepSwe"));
        // A judge model is a harness component, not a candidate.
        assert!(!rows.models.iter().any(|m| m.key.starts_with("native-")));
    }

    #[test]
    fn a_scale_that_leaves_zero_to_a_hundred_is_not_a_score() {
        assert_eq!(unit_for("elo", "Some (Elo)", None, &[1700.0]), "Elo");
        assert_eq!(unit_for("x", "thing", Some("Rating"), &[12.0]), "rating");
        // A format that mentions cost in prose does not make the score a price.
        assert_eq!(
            unit_for("deepSwe", "DeepSWE", Some("Pass@1 with confidence interval, cost, time"), &[74.2]),
            "score (0-100)"
        );
        assert_eq!(unit_for("deepSwe", "DeepSWE", Some("Pass@1"), &[77.0, 62.0]), "score (0-100)");
        assert_eq!(unit_for("gdpvalAa", "GDPval-AA", None, &[1862.0, 900.0]), "source scale");
        assert_eq!(unit_for("price:input", "price:input", None, &[0.2]), "USD / 1M tokens");
    }

    #[test]
    fn a_price_of_zero_is_a_self_hosted_model_and_not_a_free_one() {
        let rows = benchlm();
        let freebies: Vec<&Reading> = rows
            .readings
            .iter()
            .filter(|r| r.benchmark.starts_with("price:") && r.score == Some(0.0))
            .collect();
        assert!(freebies.is_empty(), "a zero price must not become a reading");
    }

    #[test]
    fn vision_and_tool_use_are_evidence_from_a_benchmark() {
        let rows = benchlm();
        let m = rows.models.iter().find(|m| m.key == "claude-sonnet-5-5").unwrap();
        assert_eq!(m.vision, Some(true));
        assert_eq!(m.tool_use, Some(true));
        let plain = rows.models.iter().find(|m| m.key == "deepseek-v3-0324");
        if let Some(plain) = plain {
            // Never `Some(false)`: absence of a reading is not evidence of absence.
            assert!(plain.vision.is_none() || plain.vision == Some(true));
        }
    }

    #[test]
    fn artificial_analysis_maps_its_indices_and_keeps_a_null_as_no_reading() {
        let rows = normalize_aa(&fixture("aa")).expect("the fixture normalizes");
        assert!(rows.readings.iter().any(|r| r.benchmark == "aa:intelligence"));
        assert!(rows.readings.iter().any(|r| r.benchmark == "aa:coding"));
        assert!(rows.readings.iter().all(|r| r.effort == "not-stated"));
        // `null` means not measured, so it is absent rather than zero.
        assert!(rows
            .readings
            .iter()
            .filter(|r| r.benchmark == "aa:agentic")
            .all(|r| r.score != Some(0.0)));
    }

    #[test]
    fn a_shape_that_is_not_the_expected_one_fails_rather_than_inventing_rows() {
        let empty = json!({"nope": []});
        assert!(normalize_benchlm(&empty, &empty, &empty, &empty).is_err());
        assert!(normalize_aa(&empty).is_err());
        let no_items = json!({"items": []});
        assert!(normalize_benchlm(&no_items, &no_items, &no_items, &no_items).is_err());
    }

    #[test]
    fn blended_price_is_three_to_one_and_nothing_else() {
        assert_eq!(blended(Some(1.0), Some(8.0)), Some(2.75));
        assert_eq!(blended(Some(1.0), None), None);
        assert_eq!(blended(None, Some(1.0)), None);
    }

    #[test]
    fn enough_is_half_the_members_by_count() {
        assert!(enough(1, 1));
        assert!(enough(2, 4));
        assert!(enough(3, 5));
        assert!(!enough(2, 5));
        assert!(!enough(0, 3));
    }

    fn entry(key: &str, quality: Option<f64>, price: Option<f64>) -> Entry {
        Entry {
            key: key.into(),
            name: key.into(),
            creator: String::new(),
            effort: "not-stated".into(),
            source: "benchlm".into(),
            quality,
            price,
            price_basis: PRICE_BASIS.into(),
            input: None,
            output: None,
            context_window: Some(1_000_000),
            vision: None,
            tool_use: None,
            efficient: false,
            rank: None,
            coverage: 1.0,
            components: Vec::new(),
            missing: Vec::new(),
        }
    }

    #[test]
    fn the_frontier_is_what_nothing_beats_on_both_axes() {
        let mut rows = vec![
            entry("cheap", Some(50.0), Some(0.1)),
            entry("middle", Some(70.0), Some(1.0)),
            entry("dear", Some(72.0), Some(5.0)),
            entry("dominated", Some(40.0), Some(9.0)),
        ];
        // The same Pareto pass `rank` runs, over a hand-made set.
        let mut order: Vec<usize> = (0..rows.len()).collect();
        order.sort_by(|a, b| rows[*a].price.partial_cmp(&rows[*b].price).unwrap());
        let mut best = f64::NEG_INFINITY;
        for i in order {
            if rows[i].quality.unwrap() > best + 1e-9 {
                rows[i].efficient = true;
                best = rows[i].quality.unwrap();
            }
        }
        assert!(rows[0].efficient);
        assert!(rows[1].efficient);
        assert!(rows[2].efficient);
        assert!(!rows[3].efficient);
        assert_eq!(dominated_by(&rows, 3).as_deref(), Some("cheap"));
    }

    #[test]
    fn a_row_without_a_price_cannot_be_placed_and_says_so() {
        let rows = vec![entry("no-price", Some(80.0), None)];
        assert!(dominated_by(&rows, 0).is_none());
    }

    #[test]
    fn a_need_that_was_never_stated_is_not_met() {
        let mut row = entry("m", Some(1.0), Some(1.0));
        assert!(!fits(&row, &json!({"vision": true})));
        row.vision = Some(true);
        assert!(fits(&row, &json!({"vision": true})));
        assert!(!fits(&row, &json!({"context": 2_000_000})));
        assert!(!fits(&row, &json!({"maxPrice": 0.5})));
        assert!(fits(&row, &json!({"maxPrice": 1.0})));
    }

    #[test]
    fn a_custom_set_is_a_profile_like_any_other() {
        let p = custom_profile(&json!({"benchmarks": ["deepSwe", {"benchmark": "hle", "weight": 3}]}))
            .unwrap()
            .unwrap();
        assert_eq!(p.members.len(), 2);
        assert_eq!(p.members[0].weight, 1.0);
        assert_eq!(p.members[1].weight, 3.0);
        assert!(custom_profile(&json!({"benchmarks": [{"weight": 3}]})).is_err());
        assert!(custom_profile(&json!({"benchmarks": [{"benchmark": "x", "weight": 0}]})).is_err());
        assert!(custom_profile(&json!({})).unwrap().is_none());
    }

    #[test]
    fn a_failed_fetch_keeps_the_last_good_reading_and_says_why() {
        let conn = rusqlite::Connection::open_in_memory().expect("in memory");
        crate::store::migrate_v76(&conn).expect("the v76 tables");
        let rows = benchlm();
        replace_source(&conn, "benchlm", &rows, 1_700_000_000_000).expect("a good fetch writes");
        let before = read_catalogue(&conn);
        assert!(!before.readings.is_empty());

        note_failure(&conn, "benchlm", "connection timed out");

        let after = read_catalogue(&conn);
        assert_eq!(after.readings.len(), before.readings.len(), "a failed fetch must not empty the cache");
        let state = after.sources.iter().find(|s| s.id == "benchlm").unwrap();
        assert_eq!(state.status, "failed");
        assert!(state.said.as_deref().unwrap_or("").contains("timed out"));
        // The date the reading was taken survives beside the fault, so the panel
        // can say how old what it is still drawing is.
        assert!(state.at.is_some());
    }

    #[test]
    fn iso_round_trips_through_the_parser() {
        let ms = 1_762_990_260_000;
        let s = iso(ms).unwrap();
        assert_eq!(parse_iso_ms(&s), Some(ms));
    }
}
