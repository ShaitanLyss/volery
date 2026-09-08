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
}
