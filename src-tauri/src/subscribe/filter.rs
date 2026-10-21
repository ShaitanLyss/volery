//! Which events a subscription wants. Pure.
//!
//! A filter is a JSON object of field → condition, written by an agent into a
//! `subscribe` call and read against every event on the source:
//!
//! ```json
//! { "channel": "ui", "modules": { "not": { "contains": "EOS" } } }
//! ```
//!
//! - **A literal means equals.** Against a field holding an array, a scalar
//!   literal means *is one of its elements* — `"modules": "EOS"` reads the way
//!   it is written, and the alternative (an array never equalling a string) is
//!   a filter that silently matches nothing.
//! - `{"in": [..]}` — the field is one of these (an array field: any element is).
//! - `{"contains": x}` — an array field has `x` as an element; a string field
//!   has `x` as a substring.
//! - `{"exists": true|false}` — the field is present (and not null), or not.
//! - `{"not": cond}` — the condition does not hold.
//! - Several operators in one condition object must all hold.
//! - At the top level, `all`, `any` and `not` take whole filters, so
//!   `{"any": [{"channel": "ui"}, {"channel": "sync"}]}` works.
//! - A field name may be a dotted path into nested objects; an exact key wins
//!   over the path, so a field genuinely called `a.b` is still reachable.
//! - `{}` matches every event.
//!
//! **A missing field fails every positive test and passes its negation.**
//! `{"modules": {"not": {"contains": "EOS"}}}` therefore matches an event with
//! no `modules` at all, which is the reading of "not about EOS" a person means.
//!
//! Compiled once, at `subscribe`, so a filter that cannot be read is refused to
//! the agent that wrote it — with what was wrong — rather than matching nothing
//! for a week. Evaluation cannot fail.

use serde_json::{Map, Value};

#[derive(Debug, Clone, PartialEq)]
pub enum Filter {
    All(Vec<Filter>),
    Any(Vec<Filter>),
    Not(Box<Filter>),
    Field(String, Cond),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Cond {
    Eq(Value),
    In(Vec<Value>),
    Contains(Value),
    Exists(bool),
    Not(Box<Cond>),
    All(Vec<Cond>),
}

/// Keys a filter object treats as structure rather than as field names. They
/// are reserved, and the tool's description says so: a field genuinely called
/// `not` cannot be filtered on, which is a smaller loss than a grammar with an
/// escape in it that every agent has to learn.
#[cfg(test)]
const RESERVED: [&str; 3] = ["all", "any", "not"];
const OPERATORS: [&str; 4] = ["in", "contains", "exists", "not"];

/// How deep a filter may nest. Ten is more than any filter a person would
/// write and keeps a hostile one off the stack.
const MAX_DEPTH: usize = 10;

pub fn compile(v: &Value) -> Result<Filter, String> {
    filter(v, 0)
}

fn filter(v: &Value, depth: usize) -> Result<Filter, String> {
    if depth > MAX_DEPTH {
        return Err("the filter nests more than ten deep".into());
    }
    let Value::Object(map) = v else {
        return Err(format!(
            "a filter is a JSON object of field to condition, like {{\"channel\": \"ui\"}} — got {}",
            kind(v)
        ));
    };
    let mut parts = Vec::new();
    for (k, val) in map {
        match k.as_str() {
            "all" | "any" => {
                let Value::Array(items) = val else {
                    return Err(format!("`{k}` takes a list of filters"));
                };
                let fs = items.iter().map(|i| filter(i, depth + 1)).collect::<Result<Vec<_>, _>>()?;
                parts.push(if k == "all" { Filter::All(fs) } else { Filter::Any(fs) });
            }
            "not" => parts.push(Filter::Not(Box::new(filter(val, depth + 1)?))),
            field => {
                if field.trim().is_empty() {
                    return Err("a field name is empty".into());
                }
                parts.push(Filter::Field(field.to_string(), cond(field, val, depth + 1)?));
            }
        }
    }
    Ok(match parts.len() {
        1 => parts.pop().unwrap(),
        _ => Filter::All(parts),
    })
}

fn cond(field: &str, v: &Value, depth: usize) -> Result<Cond, String> {
    if depth > MAX_DEPTH {
        return Err("the filter nests more than ten deep".into());
    }
    let Value::Object(map) = v else {
        return Ok(Cond::Eq(v.clone()));
    };
    /* An object whose keys are not operators is a literal object to compare
       against — rare, but refusing it would be refusing a real value. Mixed
       is the mistake worth naming. */
    let ops = map.keys().filter(|k| OPERATORS.contains(&k.as_str())).count();
    if ops == 0 {
        return Ok(Cond::Eq(v.clone()));
    }
    if ops != map.len() {
        let stray: Vec<&String> = map.keys().filter(|k| !OPERATORS.contains(&k.as_str())).collect();
        return Err(format!(
            "the condition on `{field}` mixes operators with {stray:?}; the operators are \
             `in`, `contains`, `exists` and `not`"
        ));
    }
    let mut cs = Vec::new();
    for (op, arg) in map {
        cs.push(match op.as_str() {
            "in" => match arg {
                Value::Array(a) => Cond::In(a.clone()),
                _ => return Err(format!("`in` on `{field}` takes a list")),
            },
            "contains" => Cond::Contains(arg.clone()),
            "exists" => match arg {
                Value::Bool(b) => Cond::Exists(*b),
                _ => return Err(format!("`exists` on `{field}` takes true or false")),
            },
            "not" => Cond::Not(Box::new(cond(field, arg, depth + 1)?)),
            _ => unreachable!(),
        });
    }
    Ok(match cs.len() {
        1 => cs.pop().unwrap(),
        _ => Cond::All(cs),
    })
}

fn kind(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "a boolean",
        Value::Number(_) => "a number",
        Value::String(_) => "a string",
        Value::Array(_) => "a list",
        Value::Object(_) => "an object",
    }
}

/* ── evaluation ─────────────────────────────────────────────────────────── */

pub fn matches(f: &Filter, event: &Map<String, Value>) -> bool {
    match f {
        Filter::All(fs) => fs.iter().all(|f| matches(f, event)),
        Filter::Any(fs) => fs.iter().any(|f| matches(f, event)),
        Filter::Not(f) => !matches(f, event),
        Filter::Field(name, c) => holds(c, lookup(event, name)),
    }
}

fn lookup<'a>(event: &'a Map<String, Value>, name: &str) -> Option<&'a Value> {
    if let Some(v) = event.get(name) {
        return Some(v);
    }
    let mut parts = name.split('.');
    let mut at = event.get(parts.next()?)?;
    for p in parts {
        at = at.as_object()?.get(p)?;
    }
    Some(at)
}

fn holds(c: &Cond, v: Option<&Value>) -> bool {
    let v = v.filter(|v| !v.is_null());
    match c {
        Cond::Not(c) => !holds(c, v),
        Cond::All(cs) => cs.iter().all(|c| holds(c, v)),
        Cond::Exists(want) => v.is_some() == *want,
        Cond::Eq(Value::Null) => v.is_none(),
        Cond::Eq(lit) => match v {
            Some(Value::Array(items)) if !lit.is_array() => items.iter().any(|i| same(i, lit)),
            Some(v) => same(v, lit),
            None => false,
        },
        Cond::In(list) => match v {
            Some(Value::Array(items)) => items.iter().any(|i| list.iter().any(|l| same(i, l))),
            Some(v) => list.iter().any(|l| same(v, l)),
            None => false,
        },
        Cond::Contains(x) => match v {
            Some(Value::Array(items)) => items.iter().any(|i| same(i, x)),
            Some(Value::String(s)) => x.as_str().is_some_and(|x| s.contains(x)),
            _ => false,
        },
    }
}

/// Equality, with numbers compared as numbers so `1311` equals `1311.0` —
/// the same id arriving as an integer from one writer and a float from another
/// is the same id.
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        _ => a == b,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ev(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    fn m(filter: Value, event: Value) -> bool {
        matches(&compile(&filter).unwrap(), &ev(event))
    }

    fn nova(channel: &str, modules: &[&str]) -> Value {
        json!({ "v": 1, "source": "nova-feedback", "env": "preview", "eventId": 1311,
                "itemId": "T254-8", "modules": modules, "type": "comment",
                "decision": null, "channel": channel, "at": "2026-10-21T10:00:00Z" })
    }

    /// The first two subscribers' filters, against the contract-v1 message.
    #[test]
    fn the_two_first_subscribers_each_get_their_half() {
        let coordinator = json!({ "source": "nova-feedback", "channel": "ui",
                                  "modules": { "not": { "contains": "EOS" } } });
        let eos = json!({ "channel": "ui", "modules": { "contains": "EOS" } });

        let store = nova("ui", &["Store Productivity"]);
        let eos_ui = nova("ui", &["EOS", "Store Productivity"]);
        let eos_mcp = nova("mcp", &["EOS"]);

        assert!(m(coordinator.clone(), store.clone()));
        assert!(!m(coordinator.clone(), eos_ui.clone()));
        assert!(!m(eos.clone(), store));
        assert!(m(eos.clone(), eos_ui));
        /* People only: an agent's own write through the MCP is left out. */
        assert!(!m(eos, eos_mcp.clone()));
        assert!(!m(coordinator, eos_mcp));
    }

    #[test]
    fn a_literal_against_a_list_is_membership() {
        assert!(m(json!({"modules": "EOS"}), nova("ui", &["EOS"])));
        assert!(!m(json!({"modules": "EOS"}), nova("ui", &["Store"])));
        /* A list literal is still equality with the whole list. */
        assert!(m(json!({"modules": ["EOS"]}), nova("ui", &["EOS"])));
        assert!(!m(json!({"modules": ["EOS"]}), nova("ui", &["EOS", "Store"])));
    }

    #[test]
    fn a_missing_field_fails_a_test_and_passes_its_negation() {
        let e = json!({"channel": "ui"});
        assert!(!m(json!({"modules": {"contains": "EOS"}}), e.clone()));
        assert!(m(json!({"modules": {"not": {"contains": "EOS"}}}), e.clone()));
        assert!(m(json!({"modules": {"exists": false}}), e.clone()));
        assert!(!m(json!({"modules": {"exists": true}}), e.clone()));
        /* Null reads as absent, both ways. */
        assert!(m(json!({"decision": null}), nova("ui", &[])));
        assert!(!m(json!({"decision": {"exists": true}}), nova("ui", &[])));
    }

    #[test]
    fn in_any_all_and_not_compose() {
        let e = nova("sync", &["EOS"]);
        assert!(m(json!({"channel": {"in": ["ui", "sync"]}}), e.clone()));
        assert!(m(json!({"any": [{"channel": "ui"}, {"type": "comment"}]}), e.clone()));
        assert!(!m(json!({"all": [{"channel": "ui"}, {"type": "comment"}]}), e.clone()));
        assert!(m(json!({"not": {"channel": "ui"}}), e.clone()));
        assert!(m(json!({"type": {"in": ["comment", "decision"], "not": "status"}}), e.clone()));
        assert!(m(json!({}), e.clone()), "an empty filter matches everything");
        assert!(m(json!({"modules": {"in": ["EOS", "Other"]}}), e));
    }

    #[test]
    fn strings_contain_substrings_and_numbers_compare_as_numbers() {
        assert!(m(json!({"itemId": {"contains": "T254"}}), nova("ui", &[])));
        assert!(m(json!({"eventId": 1311.0}), nova("ui", &[])));
        assert!(m(json!({"eventId": {"in": [1, 1311]}}), nova("ui", &[])));
    }

    #[test]
    fn a_dotted_name_reaches_into_an_object_and_an_exact_key_wins() {
        let e = json!({"meta": {"env": "test"}, "meta.env": "flat"});
        assert!(m(json!({"meta.env": "flat"}), e.clone()));
        let e = json!({"meta": {"env": "test"}});
        assert!(m(json!({"meta.env": "test"}), e));
    }

    #[test]
    fn a_filter_that_cannot_be_read_is_refused_with_the_reason() {
        let err = |v: Value| compile(&v).unwrap_err();
        assert!(err(json!("channel == ui")).contains("JSON object"));
        assert!(err(json!({"all": {"a": 1}})).contains("list of filters"));
        assert!(err(json!({"channel": {"in": "ui"}})).contains("takes a list"));
        assert!(err(json!({"channel": {"contains": "u", "equals": "ui"}})).contains("mixes operators"));
        assert!(err(json!({"channel": {"exists": "yes"}})).contains("true or false"));
        let mut deep = json!({"a": 1});
        for _ in 0..20 {
            deep = json!({ "not": deep });
        }
        assert!(err(deep).contains("ten deep"));
        assert!(RESERVED.contains(&"not"));
    }
}
