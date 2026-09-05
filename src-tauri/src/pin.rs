//! Putting a thing on the wall, from a card — and changing it afterwards.
//!
//! An agent that has made something to look at — a diagram, a screenshot, a
//! rendered chart, a frame out of a scene — has one way to hand it over today,
//! and that is to write a path in the transcript. Which means: you read the
//! line, you copy the path, you find something to open it with, and you come
//! back. Four gestures, and the thing that was made is not *on the wall* at any
//! point.
//!
//! There is a wall, and it already draws images. `pin` is the tool that reaches
//! it, `pinned` says what a card has up there, and `repin` changes one.
//!
//! ### Rust copies; the wall places
//!
//! The split is not arbitrary and it is the whole of this file. Copying the file
//! into the studio's own storage has to be Rust's — it is the filesystem, and
//! `import_image` already does it for the reason stated there (a reference board
//! is built up over months and must not fill with broken rectangles because you
//! tidied your downloads folder). **Sizing it cannot be Rust's**, because the
//! only thing on this machine that knows how big a PNG is without decoding one
//! is the webview: `images.svelte.ts::#measure` loads it and reads
//! `naturalWidth`. An image placed at a guessed box arrives at the wrong aspect
//! ratio, which for a diagram somebody made on purpose is the one failure worth
//! avoiding.
//!
//! So this validates and copies, and then emits. `skein.svelte.ts` places it
//! through the *same* `#place` a dropped file and a pasted screenshot go through
//! — or a pinned image and a dropped one would arrive at different sizes and in
//! different z-bands, which is exactly the note `images.svelte.ts` already has
//! on itself.
//!
//! **And placing includes choosing where**, which is the half this got wrong for
//! its whole life. Every pin landed at the card's corner plus a gap, so the
//! second one landed on top of the first and the sixth on top of five — one
//! visible rectangle standing for six pictures, which from the wall reads as the
//! app having thrown five of them away. `layout.ts::pinSpot` is the walk that
//! fixes it, and it lives at the far end of the same split for the same reason:
//! the spot cannot be chosen until the box is known, and the box is not known
//! until the webview has loaded the file.
//!
//! ### An image has a name, and only the card that made it may change it
//!
//! Rust mints the id rather than the webview, so `pin` can *say* it. That one
//! change is what makes the rest of the file possible: an agent that iterates on
//! a render can now replace the picture it put up instead of putting up a
//! seventh, which is the pile the paragraph above is about, attacked from the
//! other end.
//!
//! `repin` will only touch a row whose `pinned_by` is the calling card
//! (`store::migrate_v21`). The wall is the user's: an agent able to overwrite
//! the source of any rectangle on it — a photo you dropped this morning
//! included — is a far larger capability than the one being asked for. Same
//! argument `spawn.rs` makes about which cards a card may close.
//!
//! ### It is not a widget and it is not a note
//!
//! Only images, deliberately. A pinned *text* note would want a widget kind, a
//! config, a face and a rule of its own, and the thing an agent has to say in
//! text it can already say in the transcript — where the panel renders it
//! properly. What the transcript cannot do is show you a picture beside the card
//! that made it. That is the gap, and it is the whole gap.

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::store::Store;

pub const PIN_TOOL: &str = "pin";
pub const REPIN_TOOL: &str = "repin";
pub const PINNED_TOOL: &str = "pinned";

/// How many images one card may put up in a minute.
///
/// Four. A card rendering a frame per second onto the wall is not showing you
/// anything — it is filling the studio, and every one of them is a file copied
/// into storage that somebody has to take down by hand. The wall is yours and
/// nothing here may fill it faster than you can clear it.
const MAX_PER_MINUTE: usize = 4;
const WINDOW: std::time::Duration = std::time::Duration::from_secs(60);

/// Recent pins per card, for the rate above. In memory rather than a table: it
/// is a rate over a minute, and a rate that survived a restart would be a
/// restart that cost you the wall for a minute.
#[derive(Default)]
pub struct Pins(std::sync::Mutex<std::collections::HashMap<String, Vec<std::time::Instant>>>);

/// What the wall is asked to draw. It has already been copied by the time this
/// is emitted, so the path is inside the studio's own storage and the front end
/// need not know where it came from.
#[derive(Clone, Serialize)]
struct PinAsked {
    conversation_id: String,
    /// The copy, in `references/`.
    path: String,
    /// Minted here so the tool result can name it — see the module note.
    image_id: String,
}

/// What the wall is asked to change about one it already drew.
///
/// Every field is optional and the wall applies whichever arrived, so one call
/// can swap the picture and move it. A `remove` with anything else beside it is
/// a removal: there is nothing to move an image that is gone to.
#[derive(Clone, Serialize)]
struct RepinAsked {
    conversation_id: String,
    image_id: String,
    /// A fresh copy in `references/`, already validated, or none for a call that
    /// only moved it.
    path: Option<String>,
    /// One of the words `PLACES` names, or none.
    place: Option<String>,
    remove: bool,
}

/// The moves an agent can honestly ask for.
///
/// Deliberately words and not coordinates. An agent cannot see the wall, so a
/// number it supplied would be a guess it has no way to check — and the wall's
/// own walk already knows the sizes, the gaps and what is in the way, which is
/// everything the number would have to encode. What is left after that are the
/// three things a card genuinely means: put it back where a pin goes, bring it
/// out from behind the work, and put it back behind the work.
const PLACES: [&str; 3] = ["beside the card", "to the front", "to the back"];

pub fn pin_schema() -> Value {
    json!({
        "name": PIN_TOOL,
        "description":
            "Put an image up on the Skein wall, beside this conversation's card, where the \
             user can see it without opening anything. For something you *made* and want \
             looked at: a diagram, a chart you rendered, a screenshot of the thing you just \
             changed, a frame out of a render.\n\n\
             **This is what to do instead of writing a path in the transcript.** A path \
             costs the user four gestures — read the line, copy it, find something to open \
             it with, come back — and at no point is the thing you made actually in front \
             of them. Pin it and it is on the wall, at its own aspect ratio, next to the \
             card that made it. Say in your reply that you have pinned it and what it \
             shows.\n\n\
             It answers with the image's id. **If you are about to put up a newer version \
             of something you have already pinned, `repin` that id instead** — a second \
             copy of the same picture is two rectangles the user has to tell apart, and a \
             sixth is a wall nobody can read. `pinned` lists what you have up.\n\n\
             Images only, and the file must already exist on disk — write it first, then \
             pin it. For anything you want to *say* rather than show, say it: the \
             transcript renders markdown properly and is the right place for words. The \
             wall is the user's, so use this for the thing worth their eye and not for \
             every intermediate output.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description":
                        "The image file, as an absolute path or one relative to this \
                         conversation's working directory. png, jpg, gif, webp, bmp, avif \
                         or svg. It is copied into the studio's own storage, so you may \
                         delete or overwrite the original afterwards."
                }
            },
            "required": ["path"]
        }
    })
}

pub fn repin_schema() -> Value {
    json!({
        "name": REPIN_TOOL,
        "description":
            "Change an image you have already pinned: point it at a newer file, move it, or \
             take it down.\n\n\
             **Re-rendered something? This, not another `pin`.** The picture updates where \
             it already is, at the new file's own aspect ratio, and the user goes on looking \
             at the same rectangle instead of working out which of six is the current one. \
             It is also how a card cleans up after itself — an intermediate you pinned to \
             show your working is worth taking down once the finished thing is up.\n\n\
             Only images *this* card pinned. The wall is the user's, and everything else on \
             it — including anything they put there themselves — is theirs to arrange.\n\n\
             Say in your reply what changed, the same as for a pin: an image that quietly \
             becomes a different image is a thing the user has to notice on their own.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "image": {
                    "type": "string",
                    "description":
                        "Which image, by the id `pin` gave you, or the word `last` for the \
                         most recent one this card put up. `pinned` lists them."
                },
                "path": {
                    "type": "string",
                    "description":
                        "A newer file to draw instead, as an absolute path or one relative \
                         to this conversation's working directory. It is re-measured, so a \
                         different shape arrives at its own aspect ratio rather than \
                         stretched into the old box."
                },
                "place": {
                    "type": "string",
                    "enum": PLACES,
                    "description":
                        "Where to put it. `beside the card` sets it back down where a fresh \
                         pin would go, clear of everything else — for one that has ended up \
                         somewhere unhelpful. `to the front` lifts it over the cards, which \
                         is for the one image that is the point right now. `to the back` \
                         puts it behind the work again, which is where a reference belongs. \
                         Words rather than coordinates because you cannot see the wall; the \
                         wall knows the sizes and the gaps."
                },
                "remove": {
                    "type": "boolean",
                    "description":
                        "Take it off the wall. The user can undo it, so this is not \
                         destructive — but it is still their wall, so remove what you put \
                         up and nothing else."
                }
            },
            "required": ["image"]
        }
    })
}

pub fn pinned_schema() -> Value {
    json!({
        "name": PINNED_TOOL,
        "description":
            "What this card has on the wall: the images you have pinned, oldest first, with \
             the id each one answers to.\n\n\
             Read it before pinning something you may already have put up. The failure this \
             exists to prevent is a wall carrying six versions of one diagram with nothing \
             to say which is current — `repin` the id you find here instead. Costs nobody a \
             turn and changes nothing.\n\n\
             It cannot tell you what the wall *looks* like, and no tool here will: where \
             things are is the user's arrangement, made with a mouse, and a set of \
             coordinates is not something you can act on. What it tells you is what you are \
             responsible for.",
        "inputSchema": { "type": "object", "properties": {} }
    })
}

/// The card's working directory, for resolving a relative path against.
///
/// Resolved against *that* because it is the directory the agent has been typing
/// paths relative to all turn. An absolute path is left alone.
fn resolve(app: &AppHandle, caller: &str, want: &str) -> Result<std::path::PathBuf, String> {
    let Some(store) = app.try_state::<Store>() else {
        return Err("the store is unavailable".into());
    };
    let cwd = {
        let Ok(conn) = store.0.lock() else {
            return Err("the store is unavailable".into());
        };
        crate::store::session_of(&conn, caller).map(|(cwd, _)| cwd)
    };
    let path = std::path::Path::new(want);
    let full = if path.is_absolute() {
        path.to_path_buf()
    } else {
        match &cwd {
            Some(dir) => std::path::Path::new(dir).join(path),
            None => path.to_path_buf(),
        }
    };
    if !full.is_file() {
        return Err(format!(
            "there is no file at {}. Write the image first, then pin it — and if you meant \
             a path relative to somewhere other than this card's working directory, give \
             the absolute one.",
            full.display()
        ));
    }
    Ok(full)
}

/// Spend one of this card's four a minute, or say why not.
///
/// `repin` spends one too, when it carries a new file: a card looping render →
/// repin is copying a file into storage every time round, which is the cost the
/// rate exists to bound. A repin that only moves something is free, because
/// nothing is copied and nothing new appears.
fn spend(app: &AppHandle, caller: &str) -> Result<(), String> {
    let rate = app.state::<Pins>();
    let Ok(mut recent) = rate.0.lock() else {
        return Err("could not check the rate".into());
    };
    let seen = recent.entry(caller.to_string()).or_default();
    let now = std::time::Instant::now();
    seen.retain(|t| now.duration_since(*t) < WINDOW);
    if seen.len() >= MAX_PER_MINUTE {
        return Err(format!(
            "this conversation has put {MAX_PER_MINUTE} images on the wall in the last \
             minute, which is the limit — the wall is the user's and nothing here may fill \
             it faster than they can clear it. Pin the one that matters and describe the \
             rest."
        ));
    }
    seen.push(now);
    Ok(())
}

fn do_pin(app: &AppHandle, caller: &str, args: &Value) -> String {
    let Some(want) = args.get("path").and_then(Value::as_str).map(str::trim) else {
        return "no `path` was given, so nothing was pinned".into();
    };
    if want.is_empty() {
        return "the path was empty, so nothing was pinned".into();
    }
    let full = match resolve(app, caller, want) {
        Ok(p) => p,
        Err(e) => return e,
    };
    if let Err(e) = spend(app, caller) {
        return e;
    }

    let store = app.state::<Store>();
    let stored = match crate::store::copy_into_references(&store.1, &full) {
        Ok(p) => p,
        Err(e) => return format!("could not pin that: {e}"),
    };

    /* Minted here rather than in the webview, which is where it used to be
       minted, so that the sentence below can name it. Without a name there is
       nothing for `repin` to take and the only way to show a newer version of
       something is to put up another copy of it. */
    let image_id = crate::store::uuid_v4();

    /* The wall sizes it, chooses its spot and places it — see the module note on
       why none of that can happen here. Fire and forget: if nothing is listening
       the copy is a file in storage that `sweep_references` will collect, which
       is a better failure than refusing to answer. */
    let _ = app.emit(
        "pin:asked",
        PinAsked {
            conversation_id: caller.to_string(),
            path: stored,
            image_id: image_id.clone(),
        },
    );
    format!(
        "pinned it to the wall beside this card, at its own aspect ratio and clear of \
         anything already there. Say what it shows — an image on the wall with nothing said \
         about it is a thing the user has to work out. They can move, resize or take it \
         down like any other reference image.\n\n\
         Its id is `{image_id}`. If you make a newer version of this picture, \
         `mcp__skein__repin` that id rather than pinning a second copy."
    )
}

/// The one an agent means by an id, or by the word `last`.
///
/// Both answers are checked against `pinned_by`, so a card naming another card's
/// id — or one it read out of a transcript — is told no rather than told the
/// image does not exist. The distinction matters: "not yours" is actionable and
/// "no such image" would send it looking for a bug.
fn theirs(app: &AppHandle, caller: &str, want: &str) -> Result<crate::store::RefImage, String> {
    let store = app.state::<Store>();
    let Ok(conn) = store.0.lock() else {
        return Err("the store is unavailable".into());
    };
    if want == "last" {
        let mine = crate::store::images_pinned_by(&conn, caller)
            .map_err(|e| format!("could not read the wall: {e}"))?;
        return match mine.into_iter().next_back() {
            Some((img, _)) => Ok(img),
            None => Err("this card has not pinned anything, so there is no `last`".into()),
        };
    }
    match crate::store::image_row(&conn, want) {
        None => Err(format!(
            "there is no image `{want}` on the wall. `mcp__skein__pinned` lists the ones \
             this card put up, with their ids."
        )),
        Some(img) if img.pinned_by.as_deref() != Some(caller) => Err(format!(
            "`{want}` is on the wall but this card did not pin it, so it is not this card's \
             to change. The wall is the user's; `mcp__skein__pinned` lists what is yours."
        )),
        Some(img) => Ok(img),
    }
}

fn do_repin(app: &AppHandle, caller: &str, args: &Value) -> String {
    let Some(want) = args.get("image").and_then(Value::as_str).map(str::trim) else {
        return "no `image` was given, so nothing was changed. `mcp__skein__pinned` lists \
                the ids."
            .into();
    };
    let img = match theirs(app, caller, want) {
        Ok(i) => i,
        Err(e) => return e,
    };

    let remove = args.get("remove").and_then(Value::as_bool).unwrap_or(false);
    let asked_path = args.get("path").and_then(Value::as_str).map(str::trim);
    let place = args.get("place").and_then(Value::as_str).map(str::trim);

    if let Some(p) = place {
        if !PLACES.contains(&p) {
            return format!(
                "`{p}` is not somewhere this can put an image. It is one of: {}.",
                PLACES.join(", ")
            );
        }
    }
    if !remove && asked_path.map_or(true, str::is_empty) && place.is_none() {
        return "nothing to change — give `path` for a newer file, `place` to move it, or \
                `remove` to take it down."
            .into();
    }

    /* Ahead of the copy, so a removal does not spend a file for nothing. */
    if remove {
        let _ = app.emit(
            "repin:asked",
            RepinAsked {
                conversation_id: caller.to_string(),
                image_id: img.id.clone(),
                path: None,
                place: None,
                remove: true,
            },
        );
        return format!(
            "took `{}` off the wall. The user can undo that, so nothing is lost — say why \
             it went.",
            img.id
        );
    }

    let mut stored = None;
    if let Some(p) = asked_path.filter(|p| !p.is_empty()) {
        let full = match resolve(app, caller, p) {
            Ok(f) => f,
            Err(e) => return e,
        };
        if let Err(e) = spend(app, caller) {
            return e;
        }
        let store = app.state::<Store>();
        match crate::store::copy_into_references(&store.1, &full) {
            /* The old copy is deliberately left where it is. `sweep_references`
               collects it at the next launch, which is the same bargain
               `delete_image` strikes and for the same reason: undo has to have
               something to put back. */
            Ok(s) => stored = Some(s),
            Err(e) => return format!("could not read that image: {e}"),
        }
    }

    let _ = app.emit(
        "repin:asked",
        RepinAsked {
            conversation_id: caller.to_string(),
            image_id: img.id.clone(),
            path: stored.clone(),
            place: place.map(str::to_string),
            remove: false,
        },
    );

    let mut said = format!("changed `{}` on the wall:", img.id);
    if stored.is_some() {
        said.push_str(" it now draws the newer file, re-measured, so a different shape \
                       arrives at its own aspect ratio rather than stretched.");
    }
    match place {
        Some("beside the card") => said.push_str(
            " Set back down where a fresh pin goes, clear of everything else.",
        ),
        Some("to the front") => said.push_str(" Lifted in front of the cards."),
        Some("to the back") => said.push_str(" Put back behind the work."),
        _ => {}
    }
    said.push_str(" Say what changed — an image that quietly becomes a different image is \
                   something the user has to notice on their own.");
    said
}

fn do_pinned(app: &AppHandle, caller: &str) -> String {
    let store = app.state::<Store>();
    let Ok(conn) = store.0.lock() else {
        return "the store is unavailable".into();
    };
    let mine = match crate::store::images_pinned_by(&conn, caller) {
        Ok(m) => m,
        Err(e) => return format!("could not read the wall: {e}"),
    };
    let all = crate::store::image_count(&conn);
    drop(conn);

    if mine.is_empty() {
        return if all == 0 {
            "nothing is on the wall, and this card has pinned nothing.".into()
        } else {
            format!(
                "this card has pinned nothing. {all} image{} on the wall, all the user's — \
                 not this card's to change.",
                if all == 1 { " is" } else { "s are" }
            )
        };
    }

    let now = crate::store::now();
    let mut out = format!(
        "{} image{} from this card {} on the wall, oldest first:\n\n",
        mine.len(),
        if mine.len() == 1 { "" } else { "s" },
        if mine.len() == 1 { "is" } else { "are" },
    );
    for (img, at) in &mine {
        /* The file name and not the whole path: the path is inside the studio's
           storage and says nothing an agent can use, where the name is the one
           it chose when it wrote the file. */
        let name = std::path::Path::new(&img.path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("(unnamed)");
        out.push_str(&format!("  {}  {}  {}\n", img.id, name, ago(now - at)));
    }
    let others = all - mine.len() as i64;
    if others > 0 {
        out.push_str(&format!(
            "\nAnd {others} more on the wall that this card did not put there.",
        ));
    }
    out.push_str(
        "\n\nTo show a newer version of any of these, `mcp__skein__repin` its id rather \
         than pinning a second copy.",
    );
    out
}

fn ago(ms: i64) -> String {
    let mins = ms / 60_000;
    if mins < 1 {
        return "just now".into();
    }
    if mins < 60 {
        return format!("{mins}m ago");
    }
    let hours = mins / 60;
    if hours < 24 {
        return format!("{hours}h ago");
    }
    format!("{}d ago", hours / 24)
}

pub fn handle(app: &AppHandle, conversation_id: &str, tool: &str, args: &Value) -> Option<String> {
    match tool {
        PIN_TOOL => Some(do_pin(app, conversation_id, args)),
        REPIN_TOOL => Some(do_repin(app, conversation_id, args)),
        PINNED_TOOL => Some(do_pinned(app, conversation_id)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tool_says_what_it_replaces_and_what_it_is_not() {
        let s = pin_schema();
        assert_eq!(s["name"], PIN_TOOL);
        let d = s["description"].as_str().unwrap();
        /* The sentence that makes it worth having: an agent that does not know
           this beats writing a path will go on writing paths. */
        assert!(d.contains("instead of writing a path"), "{d}");
        /* And the boundary, or the wall fills with renderings of prose. */
        assert!(d.contains("Images only"), "{d}");
        assert!(d.contains("transcript"), "{d}");
        /* Whose wall it is. */
        assert!(d.contains("user's"), "{d}");
    }

    /* The pile is the reported bug, and half of the fix is a sentence: an agent
       that does not know `repin` exists will pin a seventh copy however well the
       wall places it. */
    #[test]
    fn pinning_points_at_repinning_before_a_second_copy_goes_up() {
        let d = pin_schema()["description"].as_str().unwrap().to_string();
        assert!(d.contains("repin"), "{d}");
        assert!(d.contains(PINNED_TOOL), "{d}");
    }

    #[test]
    fn repinning_leads_with_the_case_it_exists_for() {
        let s = repin_schema();
        assert_eq!(s["name"], REPIN_TOOL);
        let d = s["description"].as_str().unwrap();
        assert!(d.contains("Re-rendered"), "{d}");
        /* And the boundary, which is the whole of `pinned_by`. */
        assert!(d.contains("Only images *this* card pinned"), "{d}");
    }

    /* Words, not coordinates. An agent cannot see the wall, so a number it
       supplied would be a guess nothing could check — and the schema has to
       *say* that, or the next reader adds an `x` and a `y`. */
    #[test]
    fn a_move_is_named_rather_than_measured() {
        let props = &repin_schema()["inputSchema"]["properties"];
        assert!(props.get("x").is_none());
        assert!(props.get("y").is_none());
        let place = &props["place"];
        assert_eq!(place["enum"].as_array().unwrap().len(), PLACES.len());
        let d = place["description"].as_str().unwrap();
        assert!(d.contains("cannot see the wall"), "{d}");
    }

    #[test]
    fn reading_what_is_up_takes_nothing_and_says_so() {
        let s = pinned_schema();
        assert_eq!(s["name"], PINNED_TOOL);
        assert_eq!(s["inputSchema"]["properties"], json!({}));
        let d = s["description"].as_str().unwrap();
        /* It must not promise a view of the wall it cannot give. */
        assert!(d.contains("cannot tell you what the wall"), "{d}");
    }

    #[test]
    fn the_rate_is_slower_than_a_person_can_clear() {
        assert_eq!(MAX_PER_MINUTE, 4);
        assert_eq!(WINDOW.as_secs(), 60);
    }

    #[test]
    fn the_ages_read_like_the_billboard_s() {
        assert_eq!(ago(0), "just now");
        assert_eq!(ago(5 * 60_000), "5m ago");
        assert_eq!(ago(3 * 3_600_000), "3h ago");
        assert_eq!(ago(50 * 3_600_000), "2d ago");
    }
}
