//! What an `ask_user` call's arguments look like to the flyway: the walk
//! every wall numbers a question's files by, the bound on how many there may
//! be, and the scrub every string in one passes through.
//!
//! These lived in `src-tauri/src/ask.rs`, which still re-exports them under
//! their old names (`crate::ask::each_site` and the rest): the ask server is
//! the app's, and these three are the half of it two walls must agree on —
//! `look` reads a parked question's files off the wall that owns it by
//! position in `each_site`'s order.

use serde_json::Value;

/// How many files one call may attach.
///
/// The question count is deliberately unbounded — twelve decisions after a
/// round of worker reports is the shape this tool encourages, and every one of
/// them could name a file. Each attachment is a read the panel makes through
/// `find::read_file_doc`, which carries up to 24 MB base64 apiece. Twenty-four
/// is past anything a person reads in a sitting and well under anything that
/// matters.
pub const MAX_FILES: usize = 24;

/// Every place in a call's arguments that may carry a `file` or a `preview` —
/// the call itself, each of its options, each question in `questions[]` and
/// each of *its* options — in one fixed order.
///
/// **The one walk, and there are three callers that must agree on it.**
/// `attach_files` resolves what an agent named; the flyway's `look` reads the
/// resolved files off a parked question on the wall that owns it, and the wall
/// that pulled them rewrites the same sites to where it put the bytes. A file
/// is matched across the two machines by its position in this order, so a
/// second spelling of the walk would be a screenshot drawn under the wrong
/// option on the other laptop. `normalizeAsk` reads the same four sites, and
/// those are the only places a question's attachment can be drawn from.
pub fn each_site<E>(args: &mut Value, f: &mut dyn FnMut(&mut Value) -> Result<(), E>) -> Result<(), E> {
    fn options<E>(slot: Option<&mut Value>, f: &mut dyn FnMut(&mut Value) -> Result<(), E>) -> Result<(), E> {
        if let Some(list) = slot.and_then(Value::as_array_mut) {
            for option in list {
                f(option)?;
            }
        }
        Ok(())
    }
    f(args)?;
    options(args.get_mut("options"), f)?;
    if let Some(questions) = args.get_mut("questions").and_then(Value::as_array_mut) {
        for q in questions {
            f(q)?;
            options(q.get_mut("options"), f)?;
        }
    }
    Ok(())
}

/// Take the impossible characters out of every string in a JSON value, in
/// place.
///
/// Object *keys* are left alone on purpose. On the way in, a key carrying a
/// control character is a key that matches no field of any schema and is
/// therefore already inert; on the way out every key in this file is a literal
/// written here. Rebuilding the map to clean something that cannot be dirty
/// would cost an allocation on every response for nothing.
pub fn scrub_json(v: &mut Value) {
    match v {
        Value::String(s) => {
            if let std::borrow::Cow::Owned(clean) = crate::clean::scrub(s) {
                *s = clean;
            }
        }
        Value::Array(items) => items.iter_mut().for_each(scrub_json),
        Value::Object(map) => map.values_mut().for_each(scrub_json),
        _ => {}
    }
}
