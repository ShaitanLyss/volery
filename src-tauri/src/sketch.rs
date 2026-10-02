//! References to draw from, fetched ahead of time so a morning with no network
//! is still a morning you can draw.
//!
//! The dumb half, deliberately. `sketch.ts` knows what a source is, what to ask
//! it and how to read its answer; this fetches a URL, checks that what came
//! back is an image, and puts it somewhere the webview can show it. That is the
//! same split `azdo.ts` has with `azdo.rs` — the vocabulary of a service
//! belongs beside the code that reads it — and here it buys something extra:
//! adding a source is a change to one TypeScript file with a direct test, and
//! none to the thing that holds the network.
//!
//! ## Two things this is careful about
//!
//! **The two halves are checked differently, and the asymmetry is the point.**
//! A *question* goes to one of a handful of services whose shapes `sketch.ts`
//! knows, so `ALLOWED` is an exact list and widening it is a commit. An
//! *image* can come from anywhere — that is what an image search is — so there
//! is no list it could be on, and the check is instead about where a fetch may
//! not go: `public_only` refuses anything but https and refuses loopback,
//! private and link-local addresses, so this cannot be used as a way to reach
//! the machine's own services or the network it sits on.
//!
//! That is a smaller guarantee than a list and it is the honest one for the
//! feature. What actually protects the disk is three things that apply to every
//! byte either way: the magic-number sniff, the size cap, and a file name that
//! cannot climb out of the cache directory. A host list was never what made
//! those true.
//!
//! It is not airtight — a name that resolves to a private address at connect
//! time is not caught, since this reads the URL and not the socket — and that
//! is written down rather than implied. For a personal desktop app fetching
//! pictures the user asked for, it is the proportionate check.
//!
//! **The cache lives under `references/sketch/`**, inside the one directory the
//! asset protocol will serve from (`tauri.conf.json`), which is what lets the
//! gate draw a picture at all. `store::sweep_orphans` walks that directory for
//! files with no `reference_image` row and deliberately leaves subdirectories
//! alone — *"nothing puts one here, so one that exists is somebody else's and
//! not ours to collect"* — so this is the case that comment was written for.

use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::store::Store;

/// Where a request may go.
///
/// Exact host, or a dot-suffix for the CDNs these services redirect to. Short
/// on purpose: see the note above on why widening it is a commit rather than a
/// setting.
const ALLOWED: &[&str] = &[
    "api.artic.edu",
    "www.artic.edu",
    "collectionapi.metmuseum.org",
    "images.metmuseum.org",
    "picsum.photos",
    ".picsum.photos",
    /* The image search. Two requests to this host — a page, for the token its
       results endpoint demands, and then the results — and nothing else. The
       *pictures* it names are fetched under `public_only`, since an image
       search that only returned pictures from a list would not be one. */
    "duckduckgo.com",
    "html.duckduckgo.com",
];

/// A browser's user agent, because the search answers differently without one.
///
/// Not a trick: the endpoint behind the image search is a page a browser asks
/// for, and a client that declines to say what it is gets a different answer or
/// none. Probed 2026-10-02 — `curl` with this header returns the token page and
/// then 58 results; this is the same request from Rust.
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                  (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/// The most a single reference may weigh. The sources are asked for ~850px on
/// the long edge, which lands around 200KB; eight megabytes is the point at
/// which something has gone wrong rather than a limit anybody will meet.
const MAX_BYTES: usize = 8 * 1024 * 1024;

/// And the most a search answer may. The Met's search for a common word runs to
/// a few hundred kilobytes of ids, which is the largest honest answer here.
const MAX_JSON: usize = 4 * 1024 * 1024;

const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// The host a URL names, lower-cased, or an error for anything that is not an
/// https URL at all.
///
/// The `@` is the part worth knowing: `https://api.artic.edu@evil.example/` is
/// `evil.example` with a username on it, and reading up to the first `/` would
/// have called it allowed.
fn host_of(url: &str) -> Result<String, String> {
    let rest = url
        .strip_prefix("https://")
        .ok_or_else(|| format!("only https, and that is not: {url}"))?;
    let authority = rest
        .split('/')
        .next()
        .unwrap_or("")
        .split('@')
        .next_back()
        .unwrap_or("");
    /* A literal IPv6 address is bracketed and full of colons, so the port can
       only be stripped after the bracket closes. Everything else splits on the
       first one. */
    let host = if authority.starts_with('[') {
        match authority.find(']') {
            Some(i) => &authority[..=i],
            None => authority,
        }
    } else {
        authority.split(':').next().unwrap_or(authority)
    };
    Ok(host.to_ascii_lowercase())
}

fn allowed(url: &str) -> Result<(), String> {
    let host = host_of(url)?;
    let ok = ALLOWED.iter().any(|a| {
        if let Some(suffix) = a.strip_prefix('.') {
            host == suffix || host.ends_with(a)
        } else {
            host == *a
        }
    });
    if ok {
        Ok(())
    } else {
        /* Names the host rather than the URL: the URL is long and the host is
           the whole of the decision, and this message is read by whoever is
           adding a source. */
        Err(format!(
            "{host} is not a source Volery fetches from — see ALLOWED in sketch.rs"
        ))
    }
}

/// Where an *image* may come from: anywhere on the public internet, over https,
/// and nowhere on this machine or its network.
///
/// The list cannot do this job — an image search names a different CDN every
/// time — so what is checked is the shape of the host rather than its identity.
/// What it is really for is that this command is reachable from the webview and
/// writes what it fetches to disk, which without a check would be a way to ask
/// Volery to go and read `http://192.168.1.1/` or a service bound to localhost.
fn public_only(url: &str) -> Result<(), String> {
    let host = host_of(url)?;
    let private = host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || host.ends_with(".home.arpa")
        || host == "0.0.0.0"
        || host.starts_with("127.")
        || host.starts_with("10.")
        || host.starts_with("192.168.")
        || host.starts_with("169.254.")
        || host.starts_with("[::1")
        || host.starts_with("[fc")
        || host.starts_with("[fd")
        /* 172.16.0.0/12 is the one that needs arithmetic rather than a prefix. */
        || host
            .strip_prefix("172.")
            .and_then(|r| r.split('.').next())
            .and_then(|o| o.parse::<u16>().ok())
            .is_some_and(|o| (16..=31).contains(&o));
    if private {
        Err(format!("{host} is not somewhere on the public internet"))
    } else {
        Ok(())
    }
}

fn get(url: &str, cap: usize) -> Result<Vec<u8>, String> {
    let res = ureq::AgentBuilder::new()
        .timeout(TIMEOUT)
        .user_agent(UA)
        .build()
        .get(url)
        .call()
        .map_err(|e| format!("fetch {url}: {e}"))?;
    let mut body = Vec::new();
    res.into_reader()
        .take((cap + 1) as u64)
        .read_to_end(&mut body)
        .map_err(|e| format!("read {url}: {e}"))?;
    if body.len() > cap {
        return Err(format!("{url} is larger than {cap} bytes"));
    }
    Ok(body)
}

/// Ask a source a question. The answer is handed back as text and parsed in
/// `sketch.ts`, which is the only thing that knows what any of it means.
#[tauri::command]
pub async fn sketch_json(url: String) -> Result<String, String> {
    crate::off_main(move || {
        allowed(&url)?;
        let body = get(&url, MAX_JSON)?;
        String::from_utf8(body).map_err(|_| format!("{url} did not answer with text"))
    })
    .await?
}

/// One reference on disk.
#[derive(Clone, Serialize, Deserialize)]
pub struct Cached {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub credit: String,
    pub source: String,
    /// The image file. Absolute, and under `references/sketch/` — which is what
    /// makes `convertFileSrc` able to serve it.
    pub path: String,
}

fn dir(store: &Store) -> PathBuf {
    store.1.join("references").join("sketch")
}

/// What kind of image these bytes are, read off the bytes.
///
/// `store::sniff_image`'s argument, one module over and for a sharper reason:
/// the name this returns is what the asset protocol serves a content type from,
/// and here the bytes arrive from somebody else's CDN. A `Content-Type` header
/// is a claim; the magic number is the fact. It also catches the captive-portal
/// case — an HTML login page answered with 200 — which would otherwise be
/// cached as a picture and drawn as a broken image at seven in the morning.
fn sniff(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("jpg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("gif")
    } else if bytes.starts_with(b"RIFF") && bytes.len() > 12 && &bytes[8..12] == b"WEBP" {
        Some("webp")
    } else if bytes.len() > 12 && &bytes[4..8] == b"ftyp" && &bytes[8..12] == b"avif" {
        Some("avif")
    } else {
        None
    }
}

/// A file name that cannot escape the cache directory.
///
/// Ids come from `sketch.ts`, which builds them out of a source name and
/// whatever id that service uses — so they are not hostile, and they are also
/// not ours. `met-../../../etc` is a path traversal written by an API response,
/// and the cheapest defence is to allow four characters and fold everything
/// else to a dash.
fn safe_name(id: &str) -> String {
    let s: String = id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .take(80)
        .collect();
    if s.is_empty() { "reference".into() } else { s }
}

/// Fetch one image and keep it. Answers the path it was kept at.
#[tauri::command]
pub async fn sketch_cache(
    store: State<'_, Store>,
    url: String,
    id: String,
    title: String,
    artist: String,
    credit: String,
    source: String,
) -> Result<Cached, String> {
    let into = dir(&store);
    crate::off_main(move || {
        public_only(&url)?;
        let bytes = get(&url, MAX_BYTES)?;
        let Some(ext) = sniff(&bytes) else {
            return Err(format!("{url} did not answer with an image"));
        };
        std::fs::create_dir_all(&into).map_err(|e| format!("create sketch cache: {e}"))?;
        let name = safe_name(&id);
        let path = into.join(format!("{name}.{ext}"));
        std::fs::write(&path, &bytes).map_err(|e| format!("write {}: {e}", path.display()))?;
        let cached = Cached {
            id: name.clone(),
            title,
            artist,
            credit,
            source,
            path: path.to_string_lossy().to_string(),
        };
        /* The metadata rides beside the image rather than in the database, and
           that is the whole reason this needed no migration: a reference is a
           file plus a line of credit, the pair is useless apart, and a folder
           you can delete with one gesture is the right shape for a cache. */
        let side = into.join(format!("{name}.json"));
        let json = serde_json::to_string(&cached).map_err(|e| e.to_string())?;
        std::fs::write(&side, json).map_err(|e| format!("write {}: {e}", side.display()))?;
        Ok(cached)
    })
    .await?
}

fn read_cached(side: &Path) -> Option<Cached> {
    let text = std::fs::read_to_string(side).ok()?;
    let cached: Cached = serde_json::from_str(&text).ok()?;
    /* A sidecar whose image has gone is not a reference. It happens: the
       directory is one somebody may tidy by hand, and half a pair is exactly
       what that leaves. */
    if Path::new(&cached.path).is_file() {
        Some(cached)
    } else {
        None
    }
}

/// Everything already on disk.
#[tauri::command]
pub fn sketch_have(store: State<'_, Store>) -> Vec<Cached> {
    let d = dir(&store);
    let Ok(entries) = std::fs::read_dir(&d) else {
        return Vec::new();
    };
    let mut out: Vec<Cached> = entries
        .flatten()
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("json"))
        .filter_map(|e| read_cached(&e.path()))
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// Forget one — you have drawn it, or you did not want it.
#[tauri::command]
pub fn sketch_drop(store: State<'_, Store>, id: String) -> Result<(), String> {
    let d = dir(&store);
    let name = safe_name(&id);
    let side = d.join(format!("{name}.json"));
    if let Some(c) = read_cached(&side) {
        let _ = std::fs::remove_file(&c.path);
    }
    let _ = std::fs::remove_file(&side);
    Ok(())
}

/// Images in a folder of your own.
///
/// The honest answer for the artists an open-access collection cannot give you.
/// A living painter's work is in copyright, so a fetcher that went and got it
/// would be Volery redistributing somebody's work rather than finding you a
/// reference — where a folder you already have is yours, and this only looks at
/// it. Nothing is copied: the paths are read and handed over.
///
/// **Which means the asset protocol will not serve them**, since its scope is
/// `$APPDATA/references/**`. The caller copies what it wants into the cache
/// through `sketch_adopt`, which is the same gesture `import_image` makes for a
/// pinned picture, and for the same reason.
#[tauri::command]
pub async fn sketch_folder(path: String) -> Result<Vec<String>, String> {
    crate::off_main(move || {
        let d = PathBuf::from(&path);
        let entries =
            std::fs::read_dir(&d).map_err(|e| format!("read {}: {e}", d.display()))?;
        let mut out: Vec<String> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.is_file()
                    && p.extension()
                        .and_then(|x| x.to_str())
                        .map(|x| {
                            let x = x.to_ascii_lowercase();
                            ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp"]
                                .contains(&x.as_str())
                        })
                        .unwrap_or(false)
            })
            .map(|p| p.to_string_lossy().to_string())
            .collect();
        out.sort();
        Ok(out)
    })
    .await?
}

/// Take a copy of one of your own images into the cache, so it can be drawn.
#[tauri::command]
pub async fn sketch_adopt(
    store: State<'_, Store>,
    src: String,
    id: String,
    credit: String,
) -> Result<Cached, String> {
    let into = dir(&store);
    crate::off_main(move || {
        let from = PathBuf::from(&src);
        let bytes = std::fs::read(&from).map_err(|e| format!("read {}: {e}", from.display()))?;
        if bytes.len() > MAX_BYTES {
            return Err(format!("{} is larger than {MAX_BYTES} bytes", from.display()));
        }
        let Some(ext) = sniff(&bytes) else {
            return Err(format!("{} is not an image we can draw", from.display()));
        };
        std::fs::create_dir_all(&into).map_err(|e| format!("create sketch cache: {e}"))?;
        let name = safe_name(&id);
        let path = into.join(format!("{name}.{ext}"));
        std::fs::write(&path, &bytes).map_err(|e| format!("write {}: {e}", path.display()))?;
        let title = from
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("reference")
            .to_string();
        let cached = Cached {
            id: name.clone(),
            title: title.clone(),
            artist: String::new(),
            credit: if credit.is_empty() { title } else { credit },
            source: "folder".into(),
            path: path.to_string_lossy().to_string(),
        };
        let side = into.join(format!("{name}.json"));
        let json = serde_json::to_string(&cached).map_err(|e| e.to_string())?;
        std::fs::write(&side, json).map_err(|e| format!("write {}: {e}", side.display()))?;
        Ok(cached)
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_sources_this_file_knows() {
        assert!(allowed("https://api.artic.edu/api/v1/artworks/search?q=x").is_ok());
        assert!(allowed("https://www.artic.edu/iiif/2/abc/full/843,/0/default.jpg").is_ok());
        assert!(allowed("https://i.picsum.photos/id/1/200/300.jpg").is_ok());
        assert!(allowed("https://picsum.photos/v2/list").is_ok());
        /* The hole this exists to close, in the three shapes it is usually
           opened in. */
        assert!(allowed("https://evil.example/x.png").is_err());
        assert!(allowed("http://api.artic.edu/x").is_err(), "https only");
        assert!(
            allowed("https://api.artic.edu.evil.example/x").is_err(),
            "a suffix that only looks like one"
        );
        assert!(
            allowed("https://evil.example/?x=https://api.artic.edu/").is_err(),
            "the host is the first path segment, not anything later in the url"
        );
    }

    #[test]
    fn a_userinfo_trick_does_not_smuggle_a_host() {
        /* `https://api.artic.edu@evil.example/` is `evil.example` with a
           username on it, and reading up to the first `/` without taking the
           part after `@` would have called it allowed. */
        assert!(allowed("https://api.artic.edu@evil.example/x.png").is_err());
    }

    #[test]
    fn an_image_may_come_from_anywhere_public_and_nowhere_private() {
        /* The point of the whole split: an image search names a different CDN
           every time, so there is no list these could be on. */
        assert!(public_only("https://i.pinimg.com/originals/8a/x.jpg").is_ok());
        assert!(public_only("https://images.squarespace-cdn.com/content/x.jpg").is_ok());
        assert!(public_only("https://tse1.mm.bing.net/th/id/OIP.x").is_ok());

        /* And the thing it is actually for: this command is reachable from the
           webview and writes what it fetches to disk. */
        assert!(public_only("http://example.com/x.png").is_err(), "https only");
        assert!(public_only("https://localhost/x.png").is_err());
        assert!(public_only("https://127.0.0.1:8080/x.png").is_err());
        assert!(public_only("https://192.168.1.1/x.png").is_err());
        assert!(public_only("https://10.0.0.5/x.png").is_err());
        assert!(public_only("https://169.254.169.254/latest/meta-data").is_err());
        assert!(public_only("https://[::1]/x.png").is_err());
        assert!(public_only("https://nas.local/x.png").is_err());
        /* 172.16/12 is the range that needs arithmetic rather than a prefix —
           and 172.32 is outside it and must stay allowed. */
        assert!(public_only("https://172.16.0.1/x.png").is_err());
        assert!(public_only("https://172.31.255.254/x.png").is_err());
        assert!(public_only("https://172.32.0.1/x.png").is_ok());
        assert!(public_only("https://172.15.0.1/x.png").is_ok());
        /* The userinfo trick, one check over. */
        assert!(public_only("https://example.com@127.0.0.1/x.png").is_err());
    }

    #[test]
    fn a_name_cannot_climb_out_of_the_cache() {
        assert_eq!(safe_name("met-12345"), "met-12345");
        assert_eq!(safe_name("../../etc/passwd"), "------etc-passwd");
        assert!(!safe_name("a/b\\c").contains('/'));
        assert!(!safe_name("a/b\\c").contains('\\'));
        assert_eq!(safe_name(""), "reference");
        assert!(safe_name(&"x".repeat(500)).len() <= 80);
    }

    #[test]
    fn the_bytes_decide_what_an_image_is() {
        assert_eq!(sniff(b"\x89PNG\r\n\x1a\n...."), Some("png"));
        assert_eq!(sniff(b"\xff\xd8\xff\xe0...."), Some("jpg"));
        /* The captive portal, which is the failure this is really for. */
        assert_eq!(sniff(b"<!DOCTYPE html><html>sign in"), None);
        assert_eq!(sniff(b""), None);
    }
}
