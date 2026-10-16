//! Showing a thing in the conversation, from a card.
//!
//! `pin` was the only deliberate way an agent had to put something in front of
//! you, and it put it on the *wall* — beside the card, as furniture, where it
//! stays long after the conversation it belonged to has moved on. So it was used
//! for everything: a chart that was the answer to the question you had just
//! asked went up on the wall a screen away from the sentence describing it,
//! and the wall filled with pictures that had been worth a glance once.
//!
//! `show` is the other channel pin had been standing in for: the picture drawn
//! *in* the transcript, at the point in the turn where it was shown, the way an
//! image sits in a chat reply. Pin stays, for what should stay.
//!
//! ### The picture is kept, so it stays what was shown
//!
//! An agent iterating on a render writes the same `chart.png` three times and
//! shows it three times. Drawn from the path, all three figures would be the
//! third render — the transcript quietly rewriting what it had said, which is
//! exactly the "an image that quietly becomes a different image" `repin`'s
//! description warns against. So the bytes are copied into the studio's own
//! `shown/` and the figure is drawn from the copy; the tool result names the
//! copy, and since a tool result is in the session file, a card read back after
//! a restart draws the same figure with no row anywhere. No schema.
//!
//! The copies are bounded by a budget rather than by a claim rule:
//! `SHOWN_BUDGET`, oldest first, swept on every write. A swept copy is not a
//! broken figure — the front end falls back to the original path, and only
//! then says the picture is no longer kept.
//!
//! ### Text, not an image, in the result
//!
//! An MCP result can carry an `image` block, and the CLI would hand it to the
//! model — every `show` would then cost the picture's tokens on this turn and
//! ride in the cached context of every turn after it, for an act whose whole
//! point is the *user* seeing something. The agent already knows what it made.
//! So the result is a sentence, and the figure is the front end reading the
//! copy the sentence names.
//!
//! ### Only pictures are drawn, and anything else is a file you can open
//!
//! A PDF, a spreadsheet, a document: shown as a plate in the transcript that
//! opens it in the viewer, which already reads all of them
//! (`.claude/rules/finding.md`). Not copied — a plate is a way to the file as it
//! is, the same bargain a path written in prose strikes. Inline previews of
//! documents are not built; see `.claude/rules/showing.md`.

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::store::Store;

pub const SHOW_TOOL: &str = "show";

/// What the transcript draws as a picture, by extension. Exactly the wall's
/// `store::IMAGE_EXTS`: a picture you could pin is a picture you can show, and
/// two lists here would disagree about the next format somebody adds. `svg` is
/// in it, deliberately, where the file *viewer*'s media list leaves it out: the
/// viewer shows an svg as the source it is, and an `<img>` is the one element
/// that draws one with its scripts and its external references switched off —
/// which is the only way a diagram is drawn here.
pub(crate) const PICTURES: [&str; 8] = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "svg"];

/// The most one picture in the transcript may weigh, in bytes.
///
/// Three megabytes, which is `classify.ts::MAX_IMAGE_CHARS` (four million
/// characters of base64) on the other side of the encoding — the bound a tool
/// result's own picture already lives under, and for the same reason: it is
/// carried into the webview as a `data:` URL. A chart or a diagram is a few
/// hundred kilobytes; a 4K screenshot fits. Past it the tool says so and the
/// reader says so, rather than drawing half a picture.
pub(crate) const MAX_PICTURE: u64 = 3_000_000;

/// The most pixels a picture in the transcript may decode to. Bytes are not
/// the bound that matters to the window: a three-megabyte png of one colour can
/// say it is forty thousand pixels square, and decoding that is gigabytes in
/// the one webview the whole wall is drawn in — on render, now, rather than
/// behind a click. Fifty megapixels is past any screenshot or chart; past it the
/// picture is reported as too large, exactly as one over `MAX_PICTURE` is.
pub(crate) const MAX_PIXELS: u64 = 50_000_000;


/// Read a file whole, but never more than `most` bytes of it — so a file that
/// grows between the size check and the read is still bounded. `None` past it.
fn read_most(path: &std::path::Path, most: u64) -> std::io::Result<Option<Vec<u8>>> {
    use std::io::Read;
    let mut out = Vec::new();
    std::fs::File::open(path)?.take(most + 1).read_to_end(&mut out)?;
    Ok((out.len() as u64 <= most).then_some(out))
}

/// Where kept copies live, under the studio's data directory.
const SHOWN_DIR: &str = "shown";

/// How much `shown/` may hold before the oldest copies go.
///
/// 256 MB is at least eighty-five pictures at the cap and a thousand charts at
/// an ordinary size — enough that a figure you scroll back to this week is
/// still there, and a card left showing renders in a loop for a month costs a
/// bounded corner of the disk rather than an unbounded one.
const SHOWN_BUDGET: u64 = 256 * 1024 * 1024;

/// The words the front end finds the copy by. `toolcall.ts`'s `shownOf` reads
/// a result for exactly these, and `test/showing.test.ts` reads them out of this
/// file rather than transcribing them, so the two cannot drift.
pub(crate) const KEPT_MARK: &str = "kept as `";
pub(crate) const FILE_MARK: &str = "shown as a file";
/// Between a kept picture's width and height, in the parenthesis after its
/// name: `kept as \`….png\` (640×360)`.
pub(crate) const SIZE_MARK: &str = "×";

pub fn show_schema() -> Value {
    json!({
        "name": SHOW_TOOL,
        "description":
            "Show the user a picture in the conversation itself — drawn inline in the \
             transcript at this point in your turn, the way an image sits in a chat reply.\n\n\
             **Your reply's own markdown already does this, and is the first thing to reach \
             for:** `![what it is](path)` draws a picture where you write it, and a ```mermaid \
             fence is drawn as the diagram it describes — no tool needed. Use this tool when \
             the picture is a step of its own: it is kept as it was when shown, so write the \
             file again and show it again for a newer version and both stay, in order; and it \
             tells you at once if the path is wrong, where markdown cannot.\n\n\
             **Either way, this — not `pin` — is how to put something in front of the user.** \
             `pin` puts an image on the wall beside the card, where it stays as furniture after \
             the conversation has moved on: for a reference to keep in view while work goes \
             on, not for \"here is what I made\".\n\n\
             png, jpg, gif, webp, bmp, avif or svg, up to 3 MB. Any other file — a PDF, a \
             spreadsheet, a document — is shown as a file the user opens with a click, not \
             drawn. A web address is never fetched; it stays a link.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description":
                        "The file, as an absolute path or one relative to this \
                         conversation's working directory."
                },
                "caption": {
                    "type": "string",
                    "description":
                        "A line under it saying what it is — what the user should look at. \
                         Optional; your own words after the call can say it instead."
                }
            },
            "required": ["path"]
        }
    })
}

/// What the bytes say a picture is, as the extension to keep it under — or
/// `None` for bytes that are not one. The name is never trusted for this: a
/// `.png` holding an html page is not drawn, and a `.jpg` holding a png is drawn
/// as the png it is.
pub(crate) fn sniff_picture(bytes: &[u8]) -> Option<&'static str> {
    crate::store::sniff_image(bytes).or_else(|| is_svg(bytes).then_some("svg"))
}

/// Whether text bytes open as an svg document. The first thing in the file has
/// to be markup that can begin one — the element itself, an xml prolog, a
/// comment or a doctype — and an `<svg` has to appear in the head. An html page
/// with an svg somewhere in its body is not a picture.
fn is_svg(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(4096)];
    let text = String::from_utf8_lossy(head).to_ascii_lowercase();
    let t = text.trim_start_matches('\u{feff}').trim_start();
    let opens = t.starts_with("<svg")
        || t.starts_with("<?xml")
        || t.starts_with("<!--")
        || t.starts_with("<!doctype svg");
    opens && t.contains("<svg")
}

fn mime(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        _ => "image/svg+xml",
    }
}

fn ext_of(path: &std::path::Path) -> Option<String> {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .filter(|e| PICTURES.contains(&e.as_str()))
}

fn name_of(path: &std::path::Path) -> String {
    path.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("that file")
        .to_string()
}

/// A path that would make Windows open a connection to another machine just to
/// look at it. `\\host\share\x.png` — and every other spelling that reaches the
/// network redirector — is a file read that begins with an SMB handshake
/// carrying this user's credentials to whatever host the text named. An agent's
/// prose is where these paths come from, so a read is refused before anything
/// touches the disk; a picture on a share can be copied somewhere local and
/// shown from there.
///
/// **An allow-list of what a path may begin with, not a list of shares.** The
/// first cut listed the share spellings and let the long-path prefixes of a
/// local drive through, and `\\.\C:\..\UNC\host\x` walked straight past it:
/// Windows normalises `..` in a `\\.\` path, the root of one is the device
/// namespace rather than the drive, and from there the redirector is one segment
/// away (found in review). So a path is local only if it begins with a drive
/// letter, or a verbatim drive with no `..` in it — verbatim paths are not
/// normalised, so a `..` there means something nobody intends — or with no
/// prefix at all, which is a relative path or one rooted on the current drive.
/// Everything else — UNC, verbatim UNC, the device namespace, any other verbatim
/// form — is refused, along with the two-separator spellings the parser does not
/// read as a prefix on this platform.
pub(crate) fn is_remote(path: &str) -> bool {
    use std::path::{Component, Path};
    let p = path.trim();
    let b = p.as_bytes();
    let doubled = b.len() >= 2 && matches!(b[0], b'\\' | b'/') && matches!(b[1], b'\\' | b'/');
    /* `\??\` is the NT object namespace, which `std::fs` hands to Windows
       unchanged and Rust's parser reads as a rooted path with no prefix — so
       `\??\UNC\host\x` would pass as local and reach the redirector (found in
       review). Nothing a person writes begins that way; refused whole. */
    if b.len() >= 4 && matches!(b[0], b'\\' | b'/') && &b[1..3] == b"??" && matches!(b[3], b'\\' | b'/') {
        return true;
    }
    match Path::new(p).components().next() {
        #[cfg(windows)]
        Some(Component::Prefix(pre)) => {
            use std::path::Prefix;
            match pre.kind() {
                Prefix::Disk(_) => false,
                Prefix::VerbatimDisk(_) => {
                    Path::new(p).components().any(|c| c == Component::ParentDir)
                }
                _ => true,
            }
        }
        #[cfg(not(windows))]
        Some(Component::Prefix(_)) => true,
        _ => doubled,
    }
}

/* ── how big a picture is, without drawing it ──────────────────────────────
 *
 * The transcript reserves a picture's box before its bytes have decoded — or
 * before they have even been read — so prose never reflows as a figure lands
 * (`.claude/rules/showing.md`, "Zero shift"). That needs the picture's own
 * size, and every format here says it in its first few hundred bytes: a fixed
 * offset for png, gif and bmp, a marker walk for jpeg, a chunk for webp, a box
 * for avif, and the root element's attributes for an svg. No decode, and no
 * image library for what is a dozen lines a format. */

/// How much of a file is read to find its size. A jpeg's frame header can sit
/// behind a camera's EXIF block and its thumbnail, which is why this is not a
/// few hundred bytes; every other format says it far sooner.
pub(crate) const SIZE_HEAD: usize = 256 * 1024;

/// A picture's own width and height in pixels, read off its header, for the
/// box it is drawn in — or `None` where the header does not say, which leaves
/// the box to the first decode, or where the size is past anything a box could
/// sensibly be (`header_size` is the reading the pixel cap is asked of).
pub(crate) fn picture_size(bytes: &[u8]) -> Option<(u32, u32)> {
    let (w, h) = header_size(bytes)?;
    (w <= 65_535 && h <= 65_535).then_some((w as u32, h as u32))
}

/// Whether a picture's header says it decodes to more than the window should
/// hold. Asked of the size **before** any clamp: the first cut asked it of the
/// box size, which answers `None` for any side past 65,535 — and `None` passed,
/// so the cap let through exactly the pictures it exists to stop, a 65,536-wide
/// strip included (found in review). Past 65,535 on a side is too large by
/// itself, whatever the area.
pub(crate) fn too_many_pixels_in(bytes: &[u8]) -> bool {
    header_size(bytes).is_some_and(|(w, h)| w > 65_535 || h > 65_535 || w * h > MAX_PIXELS)
}

/// The size a header declares, unclamped — so the cap above sees what the
/// decoder would be asked for. Zero on a side is no size at all.
fn header_size(bytes: &[u8]) -> Option<(u64, u64)> {
    let be16 = |at: usize| Some(u16::from_be_bytes(bytes.get(at..at + 2)?.try_into().ok()?) as u64);
    let le16 = |at: usize| Some(u16::from_le_bytes(bytes.get(at..at + 2)?.try_into().ok()?) as u64);
    let be32 = |at: usize| Some(u32::from_be_bytes(bytes.get(at..at + 4)?.try_into().ok()?) as u64);
    let le24 = |at: usize| {
        let b = bytes.get(at..at + 3)?;
        Some(b[0] as u64 | (b[1] as u64) << 8 | (b[2] as u64) << 16)
    };
    let sane = |w: u64, h: u64| (w > 0 && h > 0).then_some((w, h));

    match crate::store::sniff_image(bytes) {
        /* IHDR is the first chunk, always: width and height at 16 and 20. */
        Some("png") => sane(be32(16)?, be32(20)?),
        Some("gif") => sane(le16(6)?, le16(8)?),
        Some("bmp") => {
            let w = i32::from_le_bytes(bytes.get(18..22)?.try_into().ok()?);
            /* Negative is a bitmap stored top-down; the size is the magnitude. */
            let h = i32::from_le_bytes(bytes.get(22..26)?.try_into().ok()?);
            sane(w.unsigned_abs() as u64, h.unsigned_abs() as u64)
        }
        Some("webp") => match bytes.get(12..16)? {
            b"VP8 " => sane(le16(26)? & 0x3fff, le16(28)? & 0x3fff),
            b"VP8L" => {
                let b = bytes.get(21..25)?;
                let w = 1 + (b[0] as u64 | ((b[1] as u64 & 0x3f) << 8));
                let h = 1 + ((b[1] as u64 >> 6) | ((b[2] as u64) << 2) | ((b[3] as u64 & 0x0f) << 10));
                sane(w, h)
            }
            b"VP8X" => sane(1 + le24(24)?, 1 + le24(27)?),
            _ => None,
        },
        Some("jpg") => {
            /* Walk the markers to the first frame header. Every segment but
               the standalone ones carries its own length, so this is a skip,
               not a parse. C4, C8 and CC share the SOF range and are not
               frames. */
            let mut at = 2;
            while at + 9 < bytes.len() {
                if bytes[at] != 0xff {
                    return None;
                }
                let m = bytes[at + 1];
                if m == 0xff {
                    at += 1;
                    continue;
                }
                if matches!(m, 0xd0..=0xd9 | 0x01) {
                    at += 2;
                    continue;
                }
                if matches!(m, 0xc0..=0xcf) && !matches!(m, 0xc4 | 0xc8 | 0xcc) {
                    return sane(be16(at + 7)?, be16(at + 5)?);
                }
                at += 2 + be16(at + 2)? as usize;
            }
            None
        }
        /* ISO-BMFF: the image spatial extents box, wherever the meta box put it. */
        Some("avif") => {
            let at = bytes.windows(4).position(|w| w == b"ispe")?;
            sane(be32(at + 8)?, be32(at + 12)?)
        }
        _ if is_svg(bytes) => svg_size(bytes),
        _ => None,
    }
}

/// An svg's size off its root element: `width` and `height` where they are
/// plain numbers or pixels, and otherwise the `viewBox`'s — which is what a
/// browser draws an `<img>` of an svg at when the two are missing. A size in
/// percent or ems says nothing about pixels, and is passed over for the box.
fn svg_size(bytes: &[u8]) -> Option<(u64, u64)> {
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(16 * 1024)]).to_string();
    let open = head.find("<svg")?;
    let root = &head[open..open + head[open..].find('>')?];
    let attr = |name: &str| -> Option<String> {
        let mut from = 0;
        while let Some(i) = root[from..].find(name) {
            let at = from + i;
            from = at + name.len();
            /* A whole attribute name, not the tail of `stroke-width`. */
            let before = root[..at].chars().last().unwrap_or(' ');
            if !before.is_whitespace() {
                continue;
            }
            let rest = root[at + name.len()..].trim_start();
            let rest = rest.strip_prefix('=')?.trim_start();
            let quote = rest.chars().next()?;
            if quote != '"' && quote != '\'' {
                return None;
            }
            let body = &rest[1..];
            return Some(body[..body.find(quote)?].trim().to_string());
        }
        None
    };
    let px = |v: Option<String>| -> Option<f64> {
        let v = v?;
        let n = v.strip_suffix("px").unwrap_or(&v).trim();
        n.parse::<f64>().ok().filter(|n| n.is_finite() && *n > 0.0)
    };
    let (w, h) = match (px(attr("width")), px(attr("height"))) {
        (Some(w), Some(h)) => (w, h),
        _ => {
            let vb = attr("viewBox")?;
            let n: Vec<f64> = vb
                .split(|c: char| c.is_whitespace() || c == ',')
                .filter(|s| !s.is_empty())
                .filter_map(|s| s.parse().ok())
                .collect();
            if n.len() != 4 {
                return None;
            }
            (n[2], n[3])
        }
    };
    /* An svg's size is what an `<img>` rasterises it at, so a declared
       hundred thousand pixels is a bomb exactly as a png's would be. */
    let (w, h) = (w.round().min(u32::MAX as f64) as u64, h.round().min(u32::MAX as f64) as u64);
    (w > 0 && h > 0).then_some((w, h))
}

/// The size of a picture on disk, from its head alone — what a figure's box is
/// drawn at before the picture itself is read. Cheap enough to be asked of
/// every picture in a column as it is drawn, where the read of the whole thing
/// waits until the picture is near the view.
#[tauri::command]
pub async fn measure_picture(path: String) -> Result<Measure, String> {
    crate::off_main(move || {
        let p = std::path::Path::new(&path);
        if !p.is_absolute() || is_remote(&path) || ext_of(p).is_none() {
            return Ok(Measure::default());
        }
        use std::io::Read;
        let Ok(file) = std::fs::File::open(p) else {
            return Ok(Measure::default());
        };
        let mut head = Vec::with_capacity(SIZE_HEAD);
        let _ = file.take(SIZE_HEAD as u64).read_to_end(&mut head);
        Ok(Measure::of(&head))
    })
    .await?
}

/// What a header says: the box, and whether the picture is too large to
/// decode at all. The second is the half that matters for a picture carrying
/// its own bytes, which no read stands between and the decode — so it is asked
/// before the `<img>` is given its `src` (found in review).
#[derive(Serialize, Default)]
pub struct Measure {
    size: Option<(u32, u32)>,
    #[serde(rename = "tooLarge")]
    too_large: bool,
}

impl Measure {
    fn of(head: &[u8]) -> Self {
        Measure { size: picture_size(head), too_large: too_many_pixels_in(head) }
    }
}

/// The size of a picture that carries its own bytes, from the head of its
/// base64 — the first few kilobytes are where every format says it. Rust
/// rather than a second parser in the front end, so the two ways a box is
/// reserved cannot disagree about a format.
#[tauri::command]
pub async fn measure_picture_data(head: String) -> Result<Measure, String> {
    crate::off_main(move || {
        /* Whole quanta only, or the last few bytes decode as garbage — and by
           `get`, so a head that is not base64 at all cannot panic on a byte
           index that falls inside a character. */
        let cut = head.len().min(SIZE_HEAD * 4 / 3) / 4 * 4;
        Ok(head
            .get(..cut)
            .and_then(crate::unbase64)
            .map(|b| Measure::of(&b))
            .unwrap_or_default())
    })
    .await?
}

/// A picture, ready for `src`.
#[derive(Serialize)]
pub struct Picture {
    /// `data:image/png;base64,…`, typed by what the bytes are rather than by
    /// what the file is called. Empty when `too_large`.
    #[serde(rename = "dataUrl")]
    data_url: String,
    bytes: u64,
    /// Over `MAX_PICTURE`. Said rather than truncated: half a PNG is a broken
    /// picture, and an `img` that fails to decode reads as a bug in the panel.
    #[serde(rename = "tooLarge")]
    too_large: bool,
    /// Where it was read from, whole — for a click to open it in the viewer,
    /// which for a kept copy is a place under the studio the front end has no
    /// other way to name.
    path: String,
    /// Its own size off its header, so the box is right before the `<img>` has
    /// decoded a byte. `None` where the header does not say.
    size: Option<(u32, u32)>,
}

/// Read one picture off the disk, or say why not.
pub(crate) fn picture_at(full: &std::path::Path) -> Result<Picture, String> {
    let name = name_of(full);
    if is_remote(&full.to_string_lossy()) {
        return Err(format!("{name} is on another machine's share, which is not read"));
    }
    if ext_of(full).is_none() {
        return Err(format!("{name} is not a picture this draws"));
    }
    let meta = std::fs::metadata(full).map_err(|_| format!("{name} is not there"))?;
    if !meta.is_file() {
        return Err(format!("{name} is not a file"));
    }
    let bytes = meta.len();
    let path = full.to_string_lossy().to_string();
    let head = |most: usize| -> Option<(u32, u32)> {
        use std::io::Read;
        let mut head = Vec::new();
        let f = std::fs::File::open(full).ok()?;
        let _ = f.take(most as u64).read_to_end(&mut head);
        picture_size(&head)
    };
    if bytes > MAX_PICTURE {
        /* Still measured, so the box that says it is too large stands where
           the picture would have. */
        let size = head(SIZE_HEAD);
        return Ok(Picture { data_url: String::new(), bytes, too_large: true, path, size });
    }
    let Some(data) = read_most(full, MAX_PICTURE).map_err(|e| format!("could not read {name}: {e}"))?
    else {
        return Ok(Picture { data_url: String::new(), bytes, too_large: true, path, size: head(SIZE_HEAD) });
    };
    let Some(kind) = sniff_picture(&data) else {
        return Err(format!("{name} is named as a picture but its bytes are not one"));
    };
    let size = picture_size(&data);
    if too_many_pixels_in(&data) {
        return Ok(Picture { data_url: String::new(), bytes, too_large: true, path, size });
    }
    Ok(Picture {
        data_url: format!("data:{};base64,{}", mime(kind), crate::base64(&data)),
        bytes,
        too_large: false,
        path,
        size,
    })
}

/// A picture named in an agent's prose — `![chart](C:\…\chart.png)` — for the
/// transcript to draw. The path is already whole: the front end resolves a
/// relative one against the card's directory, and only for a card that has
/// one, so a chat card's prose never reaches this.
///
/// Async through `off_main`, for the rule CLAUDE.md states: a three-megabyte
/// read and its encoding on the thread that drains the event loop is every card
/// on the wall not being painted for as long as it takes.
#[tauri::command]
pub async fn read_picture(path: String) -> Result<Picture, String> {
    crate::off_main(move || {
        let p = std::path::Path::new(&path);
        if !p.is_absolute() {
            return Err("a picture is read by its whole path".to_string());
        }
        picture_at(p)
    })
    .await?
}

/// A picture `show` kept, by the name the tool result gave it.
#[tauri::command]
pub async fn read_shown(store: tauri::State<'_, Store>, id: String) -> Result<Picture, String> {
    let dir = store.1.join(SHOWN_DIR);
    crate::off_main(move || {
        if !is_kept_name(&id) {
            return Err("that is not the name of a kept picture".to_string());
        }
        picture_at(&dir.join(&id))
    })
    .await?
}

/// Whether a name is one `keep` could have written: a v4 uuid and a picture
/// extension, and nothing else — so `read_shown` cannot be walked out of its
/// directory by a name with a separator or a `..` in it.
pub(crate) fn is_kept_name(id: &str) -> bool {
    let Some((stem, ext)) = id.split_once('.') else {
        return false;
    };
    if !PICTURES.contains(&ext) || stem.len() != 36 {
        return false;
    }
    stem.char_indices().all(|(i, c)| match i {
        8 | 13 | 18 | 23 => c == '-',
        _ => c.is_ascii_digit() || ('a'..='f').contains(&c),
    })
}

/// Write a copy under `shown/`, sweep to the budget, and hand back its name.
fn keep(data_dir: &std::path::Path, bytes: &[u8], ext: &str) -> Result<String, String> {
    let dir = data_dir.join(SHOWN_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not make a place to keep it: {e}"))?;
    let name = format!("{}.{ext}", crate::store::uuid_v4());
    std::fs::write(dir.join(&name), bytes).map_err(|e| format!("could not keep a copy: {e}"))?;
    sweep(&dir, SHOWN_BUDGET, &name);
    Ok(name)
}

/// Take the oldest copies out until what is left fits the budget. Never the one
/// just written, which is the one a figure is about to ask for. Returns how
/// many went, for the test.
fn sweep(dir: &std::path::Path, budget: u64, spare: &str) -> usize {
    let Ok(read) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut kept: Vec<(std::path::PathBuf, u64, std::time::SystemTime)> = read
        .flatten()
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            meta.is_file().then(|| {
                let at = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
                (e.path(), meta.len(), at)
            })
        })
        .collect();
    let mut total: u64 = kept.iter().map(|k| k.1).sum();
    if total <= budget {
        return 0;
    }
    kept.sort_by_key(|k| k.2);
    let mut gone = 0;
    for (path, size, _) in kept {
        if total <= budget {
            break;
        }
        if path.file_name().and_then(|n| n.to_str()) == Some(spare) {
            continue;
        }
        if std::fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(size);
            gone += 1;
        }
    }
    gone
}

fn do_show(app: &AppHandle, caller: &str, args: &Value) -> String {
    let Some(want) = args.get("path").and_then(Value::as_str).map(str::trim) else {
        return "no `path` was given, so nothing was shown".into();
    };
    if want.is_empty() {
        return "the path was empty, so nothing was shown".into();
    }
    /* Decided by what kind of card asked, never by the payload — the rule a
       question's attachment follows (`ask::attach_files`) and for its reason: a
       chat card spawns with no Read, Write or Bash, so it cannot have made the
       file, and the only paths it could name are ones it did not write. */
    if let Some(store) = app.try_state::<Store>() {
        if crate::store::kind_of(&store, caller) == "chat" {
            return "this is a chat conversation, which is spawned with no access to this \
                    machine — so it has no file to show. Describe it in words instead."
                .into();
        }
    }
    /* Before anything touches the disk: `resolve` stats the path, and a stat
       of a share is the handshake `is_remote` exists to refuse. */
    if is_remote(want) {
        return "that path is on another machine's share, which is not read — copy the file \
                somewhere on this machine and show it from there."
            .into();
    }
    let full = match crate::pin::resolve(app, caller, want, "Write the file first, then show it") {
        Ok(p) => p,
        Err(e) => return e,
    };
    let name = name_of(&full);

    if ext_of(&full).is_none() {
        return format!(
            "{FILE_MARK} in the transcript: {name}, as a plate the user opens in the viewer \
             with a click — it is not copied, so they see the file as it is when they open it. \
             Only a picture is drawn inline. Say in your reply what is in it and why it \
             matters, since the plate shows only its name."
        );
    }

    let bytes = std::fs::metadata(&full).map(|m| m.len()).unwrap_or(0);
    if bytes > MAX_PICTURE {
        return format!(
            "{name} is {:.1} MB and a picture shown in the transcript may be at most {} MB, \
             so nothing was shown. Scale it down — a chart or a diagram never needs that \
             many pixels — and show the smaller file, or write its path in your reply so the \
             user can open it.",
            bytes as f64 / 1_000_000.0,
            MAX_PICTURE / 1_000_000
        );
    }
    let data = match read_most(&full, MAX_PICTURE) {
        Ok(Some(d)) => d,
        Ok(None) => return format!("{name} grew past {} MB while it was being read, so nothing was shown.", MAX_PICTURE / 1_000_000),
        Err(e) => return format!("could not read {name}: {e}"),
    };
    let Some(kind) = sniff_picture(&data) else {
        return format!(
            "{name} is named as a picture but its bytes are not png, jpeg, gif, webp, bmp, \
             avif or svg, so nothing was shown. Check what wrote it."
        );
    };
    let size = picture_size(&data);
    if too_many_pixels_in(&data) {
        let said = header_size(&data).map(|(w, h)| format!(" is {w}×{h} pixels,")).unwrap_or_default();
        return format!(
            "{name}{said} more than the {} million pixels a picture in the transcript may \
             decode to, so nothing was shown. Scale it down and show the smaller file.",
            MAX_PIXELS / 1_000_000
        );
    }
    let Some(store) = app.try_state::<Store>() else {
        return "the store is unavailable, so nothing was shown".into();
    };
    let id = match keep(&store.1, &data, kind) {
        Ok(id) => id,
        Err(e) => return format!("could not show {name}: {e}"),
    };
    /* The copy's name, and its size, on a line of their own at the very end —
       which is where `showing.ts::shownOf` looks, and the only place it looks.
       Anchored there rather than found anywhere in the text, because a file's
       name is in the sentence above it, and a name can be written to look like
       a mark (found in review). The size is what makes the figure's box exact
       from its first frame, live and after a restart, since the result is in the
       session file. */
    let size = size.map(|(w, h)| format!(" ({w}{SIZE_MARK}{h})")).unwrap_or_default();
    format!(
        "shown {name} in the transcript, at this point in your turn, where the user is \
         reading. It is kept as it is now, so it stays what you showed even if you write the \
         file again. Your next words are read right under it: say what to look at, if the \
         caption did not.\n\n{KEPT_MARK}{id}`{size}"
    )
}

pub fn handle(app: &AppHandle, conversation_id: &str, tool: &str, args: &Value) -> Option<String> {
    match tool {
        SHOW_TOOL => Some(do_show(app, conversation_id, args)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /* The sentence that makes it worth having over `pin`, and the boundary that
       keeps pin worth having at all. */
    #[test]
    fn the_tool_says_it_is_the_default_and_pin_is_not() {
        let s = show_schema();
        assert_eq!(s["name"], SHOW_TOOL);
        let d = s["description"].as_str().unwrap();
        assert!(d.contains("not `pin`"), "{d}");
        assert!(d.contains("in the conversation"), "{d}");
        /* The training-native road first: an agent writes markdown and mermaid
           without being told to, so the tool must not read as the only way. */
        assert!(d.contains("first thing to reach"), "{d}");
        assert!(d.contains("mermaid"), "{d}");
        /* A web image is never fetched, and the description must not let an
           agent think writing a url will draw one. */
        assert!(d.contains("never fetched"), "{d}");
    }

    #[test]
    fn the_bytes_say_what_a_picture_is() {
        assert_eq!(sniff_picture(b"\x89PNG\r\n\x1a\n\x00\x00"), Some("png"));
        assert_eq!(sniff_picture(b"\xff\xd8\xff\xe0JFIF"), Some("jpg"));
        assert_eq!(
            sniff_picture(b"<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"),
            Some("svg")
        );
        assert_eq!(
            sniff_picture(b"\xef\xbb\xbf  <?xml version=\"1.0\"?>\n<svg></svg>"),
            Some("svg")
        );
        assert_eq!(sniff_picture(b"<!-- made by mermaid -->\n<svg></svg>"), Some("svg"));
        /* An html page with an svg in it is a page. */
        assert_eq!(sniff_picture(b"<!doctype html><html><body><svg></svg>"), None);
        assert_eq!(sniff_picture(b"<html><svg></svg></html>"), None);
        assert_eq!(sniff_picture(b"just some text"), None);
        assert_eq!(sniff_picture(b""), None);
    }

    #[test]
    fn a_share_is_never_read() {
        assert!(is_remote(r"\\evil.example\share\x.png"));
        assert!(is_remote("//evil.example/share/x.png"));
        assert!(is_remote(r"\\?\UNC\evil.example\share\x.png"));
        assert!(is_remote(r"  \\host\x.png"));
        assert!(is_remote(r"\/host/x.png"));
        /* The one review found: a device path's `..` climbs out of the drive into
           the device namespace, where the redirector is one segment away. The
           device namespace is refused outright, drive letter or not. */
        assert!(is_remote(r"\\.\C:\..\UNC\evil.example\share\x.png"));
        assert!(is_remote(r"\\.\C:\x.png"));
        /* The NT object namespace, whose UNC is the redirector again. */
        assert!(is_remote(r"\??\UNC\evil.example\share\x.png"));
        assert!(is_remote("/??/UNC/evil.example/x.png"));
        assert!(is_remote(r"\??\C:\x.png"));
        /* A verbatim path is not normalised, so a `..` in one is refused. */
        assert!(is_remote(r"\\?\C:\tmp\..\..\x.png"));
        /* What is local stays local. */
        assert!(!is_remote(r"\\?\C:\Users\me\x.png"));
        assert!(!is_remote(r"C:\Users\me\x.png"));
        assert!(!is_remote(r"C:\Users\..\me\x.png"));
        assert!(!is_remote(r"charts\x.png"));
        assert!(!is_remote("/home/me/x.png"));
        assert!(picture_at(std::path::Path::new(r"\\evil.example\share\x.png")).is_err());
    }

    #[test]
    fn a_kept_name_cannot_leave_its_directory() {
        let good = format!("{}.png", crate::store::uuid_v4());
        assert!(is_kept_name(&good), "{good}");
        assert!(is_kept_name("0b1f2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d.svg"));
        assert!(!is_kept_name("0b1f2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d.exe"));
        assert!(!is_kept_name("../0b1f2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c.png"));
        assert!(!is_kept_name("0b1f2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d.png/../x"));
        assert!(!is_kept_name("0B1F2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D.png"));
        assert!(!is_kept_name("chart.png"));
        assert!(!is_kept_name(""));
    }

    fn scratch(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("skein-show-{tag}-{}", crate::store::uuid_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_oldest_copies_go_first_and_never_the_newest() {
        let dir = scratch("sweep");
        for (i, name) in ["a.png", "b.png", "c.png"].iter().enumerate() {
            std::fs::write(dir.join(name), vec![0u8; 100]).unwrap();
            let at = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_000 + i as u64);
            std::fs::File::options()
                .write(true)
                .open(dir.join(name))
                .unwrap()
                .set_modified(at)
                .unwrap();
        }
        /* Within budget, nothing goes. */
        assert_eq!(sweep(&dir, 300, "c.png"), 0);
        /* Over it, the oldest goes first. */
        assert_eq!(sweep(&dir, 250, "c.png"), 1);
        assert!(!dir.join("a.png").exists());
        assert!(dir.join("b.png").exists());
        /* And the one just written survives a budget it alone exceeds. */
        assert_eq!(sweep(&dir, 10, "c.png"), 1);
        assert!(dir.join("c.png").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_kept_picture_reads_back_typed_by_its_bytes() {
        let dir = scratch("keep");
        let png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR";
        let id = keep(&dir, png, "png").unwrap();
        assert!(is_kept_name(&id), "{id}");
        let got = picture_at(&dir.join(SHOWN_DIR).join(&id)).unwrap();
        assert!(got.data_url.starts_with("data:image/png;base64,"), "{}", got.data_url);
        assert!(!got.too_large);

        /* Named a jpg, holding a png: drawn as what it is. */
        let liar = dir.join("liar.jpg");
        std::fs::write(&liar, png).unwrap();
        assert!(picture_at(&liar).unwrap().data_url.starts_with("data:image/png;"));

        /* Named a png, holding a page: not drawn at all. */
        let page = dir.join("page.png");
        std::fs::write(&page, b"<html><script>alert(1)</script></html>").unwrap();
        assert!(picture_at(&page).is_err());

        /* Too big is said, not cut. */
        let big = dir.join("big.png");
        std::fs::write(&big, vec![0u8; MAX_PICTURE as usize + 1]).unwrap();
        let got = picture_at(&big).unwrap();
        assert!(got.too_large && got.data_url.is_empty());

        /* Small on disk, enormous decoded: refused by its pixels, not its bytes. */
        let mut bomb = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR".to_vec();
        bomb.extend_from_slice(&40_000u32.to_be_bytes());
        bomb.extend_from_slice(&40_000u32.to_be_bytes());
        let bombed = dir.join("bomb.png");
        std::fs::write(&bombed, &bomb).unwrap();
        let got = picture_at(&bombed).unwrap();
        assert!(got.too_large && got.data_url.is_empty());
        assert_eq!(got.size, Some((40_000, 40_000)));

        /* And one too wide for a box to be measured at all: the cap is asked of
           the header's own numbers, so it is refused rather than let through
           for having no size (found in review). */
        let mut strip = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR".to_vec();
        strip.extend_from_slice(&65_536u32.to_be_bytes());
        strip.extend_from_slice(&1_000u32.to_be_bytes());
        let stripped = dir.join("strip.png");
        std::fs::write(&stripped, &strip).unwrap();
        let got = picture_at(&stripped).unwrap();
        assert!(got.too_large && got.size.is_none());
        assert!(too_many_pixels_in(&strip));
        /* An svg declaring a hundred thousand pixels a side is the same bomb. */
        assert!(too_many_pixels_in(b"<svg width=\"100000\" height=\"100000\">"));
        assert!(!too_many_pixels_in(b"<svg width=\"640\" height=\"360\">"));
        assert!(!too_many_pixels_in(&png[..]));
        std::fs::remove_dir_all(&dir).ok();
    }

    /* The box a figure is drawn in before it decodes comes from here, so each
       format's header is read the way the format writes it. */
    #[test]
    fn a_picture_says_its_size_in_its_header() {
        let mut png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR".to_vec();
        png.extend_from_slice(&640u32.to_be_bytes());
        png.extend_from_slice(&360u32.to_be_bytes());
        assert_eq!(picture_size(&png), Some((640, 360)));

        let gif = b"GIF89a\x20\x03\x58\x02\x00";
        assert_eq!(picture_size(gif), Some((800, 600)));

        let mut bmp = b"BM".to_vec();
        bmp.resize(18, 0);
        bmp.extend_from_slice(&300i32.to_le_bytes());
        bmp.extend_from_slice(&(-200i32).to_le_bytes());
        assert_eq!(picture_size(&bmp), Some((300, 200)));

        /* A jpeg with an APP0 segment in front of its frame header. */
        let mut jpg = vec![0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10];
        jpg.extend_from_slice(b"JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00");
        jpg.extend_from_slice(&[0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03]);
        jpg.extend_from_slice(&[0u8; 12]);
        assert_eq!(picture_size(&jpg), Some((640, 480)));

        let mut webp = b"RIFF\x00\x00\x00\x00WEBPVP8X".to_vec();
        webp.resize(24, 0);
        webp.extend_from_slice(&[0x7f, 0x02, 0x00, 0x67, 0x01, 0x00]); // 640, 360 less one
        assert_eq!(picture_size(&webp), Some((640, 360)));

        assert_eq!(
            picture_size(b"<svg xmlns='http://www.w3.org/2000/svg' width=\"420\" height=\"160px\">"),
            Some((420, 160))
        );
        /* No usable width — percent says nothing about pixels — so the viewBox. */
        assert_eq!(
            picture_size(b"<?xml version=\"1.0\"?><svg width=\"100%\" viewBox=\"0 0 300,150\">"),
            Some((300, 150))
        );
        /* `stroke-width` is not `width`. */
        assert_eq!(
            picture_size(b"<svg stroke-width=\"3\" viewBox=\"0 0 50 20\">"),
            Some((50, 20))
        );
        assert_eq!(picture_size(b"<svg>"), None);
        assert_eq!(picture_size(b"\x89PNG\r\n\x1a\n"), None);
        assert_eq!(picture_size(b"nothing"), None);
    }

    #[test]
    fn the_marks_the_front_end_reads_are_in_what_it_says() {
        /* `shownOf` finds a copy and a plate by these; a reworded result that
           dropped one would draw every figure as a failure. The TS half reads
           the constants out of this file (`test/showing.test.ts`). */
        assert_eq!(KEPT_MARK, "kept as `");
        assert_eq!(FILE_MARK, "shown as a file");
    }
}
