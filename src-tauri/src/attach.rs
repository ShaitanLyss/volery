//! Reading an image a card is about to be shown.
//!
//! An image reaches a prompt two ways and only one of them needs Rust. A
//! **paste** carries its own bytes — that is the whole reason the feature
//! exists, since a screen capture writes nothing to disk — and the webview can
//! read them off the clipboard event unaided. A **drop** carries a filesystem
//! path, because Tauri's drag-drop hands over real paths rather than blobs, and
//! there is no `fs` plugin on this app: the asset protocol is scoped to
//! `$APPDATA/references/**` (`tauri.conf.json`) precisely so that a webview
//! cannot read arbitrary files. So one command reads one file.
//!
//! ## Why not `import_image`
//!
//! `store::import_image` already copies a path into `references/` and hands
//! back somewhere the asset protocol will serve from, and reusing it would have
//! been one line. It is the wrong home twice over:
//!
//! - **`sweep_references` deletes every file in there that no `image` row points
//!   at.** An attachment has no row — it is not on the wall, it is in a sentence
//!   — so the copy would be collected out from under a draft you had not sent
//!   yet, at whatever moment the next sweep ran.
//! - **A reference board is built up over months.** Dropping a screenshot into a
//!   prompt is not a statement that you want it pinned up, and a folder of
//!   pictures you never chose to keep is the sort of mess that gets a feature
//!   turned off.
//!
//! Nothing is copied at all, then: the bytes go straight to the webview, which
//! is going to decode and very often *rescale* them anyway (`attach.ts`'s
//! `MAX_SIDE`), so a file on disk in between would be a copy of something
//! nobody sends.
//!
//! ## The cap is here rather than only in the webview
//!
//! `MAX_READ` refuses a file before it is read, and the webview has a ceiling of
//! its own after scaling. Both are wanted and they are not the same check: the
//! webview's is about what the API will take, this one is about not turning a
//! 900 MB video somebody dropped by accident into 1.2 GB of base64 held across
//! an IPC boundary. A cap that only bites after the read has already happened is
//! not a cap on anything.

use serde::Serialize;

/// The largest file that will be read off disk for a prompt.
///
/// Well above anything the API takes (5 MB) because this is not that limit —
/// the webview scales a large capture down and *then* checks, so a 30 MB raw
/// PNG is a perfectly ordinary thing to drop and becomes a few hundred KB. What
/// this stops is a file that was never an image being turned into a string a
/// third larger than itself and pushed through IPC.
const MAX_READ: u64 = 64 * 1024 * 1024;

/// One image, as the webview wants it.
#[derive(Serialize)]
pub struct Read {
    /// What the extension says it is. The webview checks this against
    /// `attach.ts::MEDIA` and does not have to trust it — it decodes the bytes
    /// itself, and a file that is not really an image fails there.
    pub media_type: String,
    /// Base64, no data-URL preamble, which is what the wire wants and what
    /// `attach.svelte.ts` hands through untouched when nothing needs scaling.
    pub data: String,
    /// The file's own name, so the token in the draft can be named after it.
    pub name: String,
}

/// What an extension means, or nothing.
///
/// The same four the API takes and `attach.ts::MEDIA` lists. Deliberately
/// narrower than `store::classify_drop`'s set, which also admits `bmp` and
/// `avif` — those can be *pinned to the wall*, where the webview renders them,
/// and cannot be *sent*, where the API decides. Two questions, two lists; a
/// single shared one would have to be the narrower, which would stop you
/// pinning up a bmp for no reason anybody could see.
pub fn media_type_of(path: &std::path::Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => return None,
    })
}

/// Read one image off disk for attaching to a prompt.
///
/// `async` per the rule in CLAUDE.md: this is a file read of up to `MAX_READ`
/// plus a base64 encode of the same, and doing it on the thread that drains the
/// event loop stops every card on the wall being painted for as long as it
/// takes. `crate::off_main` is the whole of what makes it safe.
#[tauri::command]
pub async fn read_attachment(path: String) -> Result<Read, String> {
    crate::off_main(move || {
        let p = std::path::Path::new(&path);

        let media = media_type_of(p)
            .ok_or_else(|| format!("{} is not an image this can send", name_of(p)))?;

        let meta = std::fs::metadata(p).map_err(|e| format!("{}: {e}", name_of(p)))?;
        if !meta.is_file() {
            return Err(format!("{} is not a file", name_of(p)));
        }
        if meta.len() > MAX_READ {
            return Err(format!(
                "{} is {} MB, which is too large to attach",
                name_of(p),
                meta.len() / (1024 * 1024)
            ));
        }

        let bytes = std::fs::read(p).map_err(|e| format!("{}: {e}", name_of(p)))?;
        Ok(Read {
            media_type: media.to_string(),
            /* The house encoder in `lib.rs`, which is where it moved when it
               got its second caller. This is the third, and it is the one that
               makes the padding remark on it literal: a payload short by an `=`
               is an image the API refuses. */
            data: crate::base64(&bytes),
            name: name_of(p),
        })
    })
    .await?
}

/* ── a picture carried to another wall's card ─────────────────────────────── */

/// How many pictures one prompt may carry — `attach.ts::MAX_ATTACHED`, the
/// dock's own cap, held equal by `test/attach.test.ts`.
pub const MAX_ATTACHED: usize = 20;

/// The largest one picture may be, in bytes of the encoded file —
/// `attach.ts::MAX_BYTES`, which is the API's own limit. Held equal by
/// `test/attach.test.ts`.
pub const MAX_BYTES: usize = 5 * 1024 * 1024;

/// The most one prompt may cost on the wire to another wall: its words as JSON
/// and its pictures' base64 together. `attach.ts::CARRY_MOST`, held equal by
/// `test/attach.test.ts`.
///
/// **This is the frame's number, not the API's.** A prompt rides one sealed
/// frame (`FleetMsg::Pictured`) and a frame is at most `wire::MAX_FRAME`, 8 MB,
/// which a wall refuses to read past — and refusing it fails the *whole*
/// exchange, the sink and the cards beside it. So the ceiling is set a
/// megabyte under, for the ask's other fields and the seal, rather than to the
/// millimetre (`a_prompt_at_the_ceiling_still_fits_a_frame`). One picture at
/// `MAX_BYTES` is 6.7 MB of base64 and fits; a handful of full-size screenshots
/// together may not, and are refused in words with the draft kept. A local
/// prompt has no such ceiling, and that is the one difference.
pub const CARRY_MOST: usize = 7 * 1024 * 1024;

/// The longest a picture's name may be. `attach.ts::nameFromFile` cuts at 32 and
/// `uniqueName` adds a few characters; this is room above both, and a bound on a
/// string another machine wrote.
const NAME_MOST: usize = 64;

/// Whether these pictures may ride (or be handed on with) a prompt whose words
/// are `text`, and if not, why — in a sentence for the person who attached
/// them. Asked by the wall that sends, before anything is queued, and again by
/// the wall the card is on, before anything is handed to it: the bytes came
/// from another machine, and both the media type and the data end up inside a
/// `src=` and in a request the API will refuse if they disagree.
///
/// **Refused whole, never mended** (`attach.md`): a picture taken out of a
/// prompt leaves its `[name]` in the sentence pointing at nothing, which is the
/// one thing `Attachments.prune` exists to prevent. The webview on the owning
/// wall decodes each again (`Attachments.fromCarried`), which is the real
/// "is this an image" check; this is the shape, and the one that runs in Rust.
pub fn carried_fit(pictures: &[crate::flyway::fleet::Picture], text: &str) -> Result<(), String> {
    if pictures.len() > MAX_ATTACHED {
        return Err(format!("{} pictures — {MAX_ATTACHED} is the most one prompt carries", pictures.len()));
    }
    let mut cost = serde_json::to_string(text).map(|s| s.len()).unwrap_or(text.len());
    let mut seen: Vec<&str> = Vec::with_capacity(pictures.len());
    for p in pictures {
        let name = p.name.as_str();
        let called = if name.trim().is_empty() { "a picture" } else { name };
        if name.trim().is_empty()
            || name.chars().count() > NAME_MOST
            || name.contains(['[', ']'])
            || crate::clean::scrub(name).len() != name.len()
        {
            return Err(format!("{} has a name that cannot sit in a sentence", crate::clean::scrub(called)));
        }
        if seen.contains(&name) {
            return Err(format!("two pictures are both called {name}"));
        }
        seen.push(name);
        if !text.contains(&format!("[{name}]")) {
            return Err(format!("{name} is not in the sentence — its [{name}] is missing"));
        }
        if !["image/png", "image/jpeg", "image/gif", "image/webp"].contains(&p.media_type.as_str()) {
            return Err(format!("{name} is not an image this can send"));
        }
        let data = p.data.as_str();
        if data.is_empty()
            || data.len() % 4 != 0
            || !data.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'=')
        {
            return Err(format!("{name} did not arrive as an image"));
        }
        let pad = data.bytes().rev().take_while(|b| *b == b'=').count();
        if pad > 2 || data[..data.len() - pad].contains('=') {
            return Err(format!("{name} did not arrive as an image"));
        }
        let bytes = data.len() / 4 * 3 - pad;
        if bytes > MAX_BYTES {
            return Err(format!("{name} is too large to send ({} MB)", bytes.div_ceil(1024 * 1024)));
        }
        /* The first bytes say what the file is, and they must say what the
           media type does: the API refuses a request where the two disagree,
           and that 400 names nothing. Sixteen characters are twelve bytes,
           which covers WebP's `RIFF….WEBP`. */
        let head = crate::unbase64(&data[..data.len().min(16)]).unwrap_or_default();
        if !media_matches(&p.media_type, &head) {
            return Err(format!("{name} is not the {} it says it is", p.media_type));
        }
        cost += data.len() + name.len() + p.media_type.len() + 48;
    }
    if cost > CARRY_MOST {
        return Err(format!(
            "this prompt comes to {} MB and at most {} MB goes to another wall at once — send fewer pictures, or smaller ones",
            mb(cost),
            CARRY_MOST / (1024 * 1024)
        ));
    }
    Ok(())
}

/// One decimal place of a megabyte, for a sentence.
fn mb(n: usize) -> String {
    format!("{:.1}", n as f64 / (1024.0 * 1024.0))
}

/// Whether a file's first bytes are the format its media type names.
fn media_matches(media: &str, head: &[u8]) -> bool {
    match media {
        "image/png" => head.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => head.starts_with(&[0xFF, 0xD8, 0xFF]),
        "image/gif" => head.starts_with(b"GIF87a") || head.starts_with(b"GIF89a"),
        "image/webp" => head.len() >= 12 && head.starts_with(b"RIFF") && &head[8..12] == b"WEBP",
        _ => false,
    }
}

/// A file's own name, for a message somebody reads. The whole path would put an
/// absolute path in the fault bar for a file the user just dragged in and can
/// plainly see.
fn name_of(p: &std::path::Path) -> String {
    p.file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("that file")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    /// The four the API takes, and case does not matter — a `.PNG` off a
    /// Windows share is the ordinary spelling of one.
    #[test]
    fn the_four_sendable_types_are_recognised() {
        assert_eq!(media_type_of(Path::new("a.png")), Some("image/png"));
        assert_eq!(media_type_of(Path::new("a.JPG")), Some("image/jpeg"));
        assert_eq!(media_type_of(Path::new("a.jpeg")), Some("image/jpeg"));
        assert_eq!(media_type_of(Path::new("a.gif")), Some("image/gif"));
        assert_eq!(media_type_of(Path::new("a.WebP")), Some("image/webp"));
    }

    /// The two that may be pinned to the wall and may not be sent. This is the
    /// asymmetry the doc comment argues for, and it is worth an assertion
    /// because the obvious tidy-up is to share one list with `classify_drop`.
    #[test]
    fn a_pinnable_type_is_not_therefore_a_sendable_one() {
        assert_eq!(media_type_of(Path::new("a.bmp")), None);
        assert_eq!(media_type_of(Path::new("a.avif")), None);
    }

    #[test]
    fn anything_else_is_refused_at_the_door() {
        assert_eq!(media_type_of(Path::new("notes.txt")), None);
        assert_eq!(media_type_of(Path::new("a.mp4")), None);
        assert_eq!(media_type_of(Path::new("no-extension")), None);
    }

    /// A path is never quoted whole at somebody. The file is one they can see.
    #[test]
    fn a_refusal_names_the_file_and_not_the_path() {
        assert_eq!(name_of(Path::new(r"C:\Users\someone\pics\shot.png")), "shot.png");
    }

    use crate::flyway::fleet::Picture;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";

    fn pic(name: &str, media: &str, bytes: &[u8]) -> Picture {
        Picture { name: name.into(), media_type: media.into(), data: crate::base64(bytes) }
    }

    /// What the dock sends passes, on both walls.
    #[test]
    fn a_picture_the_dock_would_send_fits() {
        let jpeg = [0xFF, 0xD8, 0xFF, 0xE0, 0, 16];
        let ps = [pic("image 1", "image/png", PNG), pic("shot.jpg", "image/jpeg", &jpeg)];
        assert_eq!(carried_fit(&ps, "look at [image 1], then [shot.jpg]"), Ok(()));
        assert_eq!(carried_fit(&[], "words alone"), Ok(()));
    }

    /// **Refused whole, never mended** — each of the ways a payload from
    /// another machine can be wrong, and each says which picture.
    #[test]
    fn a_picture_that_is_not_what_it_says_is_refused_by_name() {
        let png = |name: &str| pic(name, "image/png", PNG);
        let refused = |ps: &[Picture], text: &str| carried_fit(ps, text).unwrap_err();
        assert!(refused(&[png("a")], "no token here").contains("not in the sentence"));
        assert!(refused(&[png("a"), png("a")], "[a]").contains("both called a"));
        assert!(refused(&[png("a]b")], "[a]b]").contains("cannot sit in a sentence"));
        assert!(refused(&[png("a\u{0}")], "[a\u{0}]").contains("cannot sit in a sentence"));
        assert!(refused(&[pic("a", "image/bmp", PNG)], "[a]").contains("not an image this can send"));
        assert!(refused(&[pic("a", "image/jpeg", PNG)], "[a]").contains("not the image/jpeg it says"));
        let mut quote = png("a");
        quote.data.replace_range(4..5, "\"");
        assert!(refused(&[quote], "[a]").contains("did not arrive as an image"));
        /* All padding, or padding in the middle, is not base64 — and the first
           would underflow the size arithmetic. */
        for data in ["====", "AA==AAAA"] {
            let p = Picture { data: data.into(), ..png("a") };
            assert!(refused(&[p], "[a]").contains("did not arrive as an image"), "{data}");
        }
        let many: Vec<Picture> = (0..=MAX_ATTACHED).map(|i| png(&format!("p{i}"))).collect();
        let text: String = many.iter().map(|p| format!("[{}]", p.name)).collect();
        assert!(refused(&many, &text).contains("most one prompt carries"));
    }

    /// One picture past the API's limit is refused for its own size; pictures
    /// each under it but too many together are refused for the prompt's.
    #[test]
    fn too_large_is_said_in_megabytes() {
        let mut big = PNG.to_vec();
        big.resize(MAX_BYTES + 3, 0);
        let why = carried_fit(&[pic("big", "image/png", &big)], "[big]").unwrap_err();
        assert!(why.contains("too large to send (6 MB)"), "{why}");
        let mut four = PNG.to_vec();
        four.resize(4 * 1024 * 1024, 0);
        let two = [pic("a", "image/png", &four), pic("b", "image/png", &four)];
        let why = carried_fit(&two, "[a] [b]").unwrap_err();
        assert!(why.contains("10.7 MB") && why.contains("at most 7 MB"), "{why}");
    }

    /// The ceiling leaves a frame room for everything else in the ask and for
    /// the seal — a megabyte, not a few bytes — and the largest single picture
    /// the dock allows still fits under it.
    #[test]
    fn a_prompt_at_the_ceiling_still_fits_a_frame() {
        assert!(CARRY_MOST + 1024 * 1024 <= crate::flyway::wire::MAX_FRAME);
        let mut one = PNG.to_vec();
        one.resize(MAX_BYTES, 0);
        assert_eq!(carried_fit(&[pic("one", "image/png", &one)], "[one]"), Ok(()));
    }
}
