//! The seeing half of the link: answering a `see` for a person at another
//! wall, and asking one of the wall a card runs on.
//!
//! `seeing.rs` is the vocabulary, the one boundary and the reasoning; this is
//! the wiring — the gate that needs the store, the exchanges, and the two
//! folders this wall keeps what it was sent in. A child of `link.rs` for
//! `moves.rs`'s reason.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use super::{current, Frame, Link};
use crate::flyway::fleet::{self, Act, Origin, Refusal};
use crate::flyway::here;
use crate::flyway::seeing::{self, Grounds, Held, SeeMsg, Sight};
use crate::flyway::wire;

/// The most `see`s one exchange may carry. The asker sends one at a time;
/// this bounds a peer that sends a pile, each of which is a disk read.
pub(super) const SEES_PER_EXCHANGE: usize = 4;

/// Where pictures from other walls are kept, under this wall's data folder.
const PICTURES_DIR: &str = "afar-pictures";

/// Where a file another wall's card named is put for the viewer to read.
const FILES_DIR: &str = "afar-files";

/// How much the picture cache may hold before the oldest go — the budget
/// `show` keeps its own copies to, for its reasons.
const PICTURES_BUDGET: u64 = crate::show::SHOWN_BUDGET;

impl Link {
    /// One answer to a `see`, for the wall `from`. Gated here, on this wall's
    /// switch read fresh and the card's own birth, by `fleet::may_reach` — the
    /// rule an agent's `recall` is held to, with the asking person as the
    /// origin (`seeing.rs`, "Who may"). Then the read, off the main thread.
    pub(super) async fn see_here(self: &Arc<Self>, id: String, card: String, ask: Sight, from: Option<String>) -> SeeMsg {
        let refuse = |why: String| SeeMsg::Seen { id: id.clone(), why: Some(why), stats: None, names: None, picture: None, part: None };
        let Some(asker) = from else {
            return refuse(format!("{} could not tell which wall asked", self.me));
        };
        let card: String = crate::clean::scrub(card.trim()).chars().take(80).collect();
        if card.is_empty() {
            return refuse("no card was named".into());
        }
        let Some(store) = self.store() else {
            return refuse(format!("{} is still starting", self.me));
        };
        let shown = store.1.join(crate::show::SHOWN_DIR);
        let (session, born, accepting) = {
            let Ok(conn) = store.0.lock() else {
                return refuse(format!("{} could not read its own wall just then — try again", self.me));
            };
            let session = crate::store::session_of(&conn, &card);
            let born = here::birth_of(&conn, &card).map(|b| Origin { host: b.host, card: b.asker_card });
            (session, born, here::accepting(&conn))
        };
        let Some((base, session)) = session else {
            return refuse(format!("no card {card} is on {} — it may have been closed since it was drawn there", self.me));
        };
        let person = Origin { host: asker, card: None };
        if let Err(r) = fleet::may_reach(Act::Recall, &person, accepting, false, born.as_ref(), false) {
            return refuse(match r {
                Refusal::NotAccepting => format!(
                    "{} reads its files for another wall only while it takes work from other walls, or for the \
                     wall that opened the card — switch that on in the flyway panel on {}",
                    self.me, self.me
                ),
                other => other.reason(&self.me),
            });
        }
        /* Where the CLI keeps this card's conversation — the run directory
           `session_of` folded, which is the one the CLI filed it under. */
        let transcript = session.and_then(|s| crate::supervisor::transcript_path(&self.app, &base, &s).ok());
        let g = Grounds { base: Some(PathBuf::from(base)), shown, transcript, me: self.me.clone() };
        let id2 = id.clone();
        crate::off_main(move || seeing::answer(&id2, ask, &g)).await.unwrap_or_else(refuse)
    }

    /// Ask `host` one `see`, and keep the answer out of the same exchange. A
    /// read never moves the tick's backoff, for `read_tail`'s reason.
    async fn read_see(self: &Arc<Self>, host: &str, card: &str, ask: Sight, within: Duration) -> Result<SeeMsg, String> {
        let peer = self.wire.peer(host)?;
        let id = crate::store::uuid_v4();
        let m = SeeMsg::See { id: id.clone(), card: card.to_string(), ask };
        let back = self
            .wire
            .exchange_within(peer, vec![Frame::See(m)], true, within)
            .await
            .map_err(|e| format!("could not reach {host}: {e}"))?;
        let mut sees = Vec::new();
        let mut rest = Vec::new();
        for f in back {
            match f {
                Frame::See(m) => sees.push(m),
                other => rest.push(other),
            }
        }
        self.take(rest, Some(host));
        seeing::answer_in(sees, &id, host)
    }
}

/// The link, a host that can be asked and a card — or the sentence. Said at
/// once for a wall that is unknown, quiet or too old, never waited on.
async fn ready(app: &AppHandle, host: &str, card: &str) -> Result<(Arc<Link>, String, String), String> {
    ready_for(app, host, card, seeing::WORD, "cannot show its cards' files to another wall — update it there to see them here").await
}

/// `ready`, for a reading behind a word of its own.
async fn ready_for(
    app: &AppHandle,
    host: &str,
    card: &str,
    word: &'static str,
    older: &'static str,
) -> Result<(Arc<Link>, String, String), String> {
    let Some(l) = current(app) else {
        return Err("this wall is not on a flyway, so it cannot read another wall's files".into());
    };
    let (host, card) = (host.trim().to_string(), card.trim().to_string());
    if host.is_empty() || card.is_empty() {
        return Err("no card was named".into());
    }
    let check = l.clone();
    let h = host.clone();
    crate::off_main(move || check.reachable(&h, word, older)).await??;
    Ok((l, host, card))
}

/// Which of these paths a card on another wall names are files there — the
/// counterpart of `find::classify_paths`, answered by the wall the card runs
/// on. A folder is left out: opening one is Explorer, and Explorer runs on
/// this machine, so a folder there is drawn as the words it is.
#[tauri::command]
pub async fn flyway_see_stat(app: AppHandle, host: String, card: String, paths: Vec<String>) -> Result<HashMap<String, String>, String> {
    let (l, host, card) = ready(&app, &host, &card).await?;
    let paths: Vec<String> = paths.into_iter().take(seeing::STAT_MOST).collect();
    match l.read_see(&host, &card, Sight::Stat { paths }, Duration::from_secs(20)).await? {
        SeeMsg::Seen { stats: Some(s), .. } => Ok(s.into_iter().filter(|(_, k)| k == "file").collect()),
        _ => Err(format!("{host} did not say which of those are files")),
    }
}

/// Which file a bare name is, across a card's tree on another wall — the
/// counterpart of `find::find_names`.
#[tauri::command]
pub async fn flyway_see_names(app: AppHandle, host: String, card: String, names: Vec<String>) -> Result<HashMap<String, Vec<String>>, String> {
    let (l, host, card) = ready(&app, &host, &card).await?;
    let names: Vec<String> = names.into_iter().take(seeing::NAMES_MOST).collect();
    match l.read_see(&host, &card, Sight::Names { names }, Duration::from_secs(20)).await? {
        SeeMsg::Seen { names: Some(n), .. } => Ok(n
            .into_iter()
            .map(|(k, v)| {
                let v = v.into_iter().map(|p| crate::clean::scrub(&p).chars().take(400).collect()).collect();
                (k, v)
            })
            .collect()),
        _ => Err(format!("{host} did not say which files those are")),
    }
}

/// What a picture from another wall says of its size — `show::Measure`'s
/// shape, so `InlinePicture` reads one answer whichever wall it asked.
#[derive(Serialize)]
pub struct Measured {
    size: Option<(u32, u32)>,
    #[serde(rename = "tooLarge")]
    too_large: bool,
}

/// A picture from another wall, ready for `src` — `show::Picture`'s shape and
/// two fields more.
#[derive(Serialize)]
pub struct Seen {
    #[serde(rename = "dataUrl")]
    data_url: String,
    bytes: u64,
    #[serde(rename = "tooLarge")]
    too_large: bool,
    /// Always empty: nothing on this machine is where it came from, so there
    /// is no file here for a click to open.
    path: String,
    size: Option<(u32, u32)>,
    /// The kept copy had gone over there, and this is the file it came from.
    stale: bool,
    /// Something the title should say about where these bytes came from —
    /// drawn from this wall's copy because the other wall could not be asked.
    note: Option<String>,
}

fn pictures_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join(PICTURES_DIR))
}

fn files_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join(FILES_DIR))
}

/// Where one picture from one card on one wall is kept here — never by its
/// own name, which another card or wall can share for another picture. A
/// tool call's picture is named by the call and its place in the result.
fn held_at(app: &AppHandle, host: &str, card: &str, kept: Option<&str>, path: Option<&str>, call: Option<(&str, u32)>) -> Result<PathBuf, String> {
    let host = host.to_ascii_lowercase();
    let k = match call {
        Some((id, n)) => seeing::key(&[&host, card, "call", id, &n.to_string()]),
        None => seeing::key(&[&host, card, kept.unwrap_or(""), path.unwrap_or("")]),
    };
    Ok(pictures_dir(app)?.join(format!("{k}.pic")))
}

fn seen_from(meta: &Held, bytes: &[u8], note: Option<String>) -> Option<Seen> {
    let kind = crate::show::sniff_picture(bytes)?;
    Some(Seen {
        data_url: format!("data:{};base64,{}", crate::show::mime(kind), crate::base64(bytes)),
        bytes: bytes.len() as u64,
        too_large: false,
        path: String::new(),
        size: crate::show::picture_size(bytes),
        stale: meta.stale,
        note,
    })
}

/// Three pulls at a time — each holds a picture in memory twice over.
async fn turn() -> Result<tokio::sync::SemaphorePermit<'static>, String> {
    static PULLS: std::sync::OnceLock<tokio::sync::Semaphore> = std::sync::OnceLock::new();
    PULLS
        .get_or_init(|| tokio::sync::Semaphore::new(3))
        .acquire()
        .await
        .map_err(|_| "this wall has stopped reading other walls' pictures".to_string())
}

/// The size of a picture one of another wall's cards named — what its box is
/// drawn at before the picture is pulled. A copy this wall already holds says
/// it without asking.
#[tauri::command]
pub async fn flyway_see_measure(
    app: AppHandle,
    host: String,
    card: String,
    kept: Option<String>,
    path: Option<String>,
) -> Result<Measured, String> {
    let at = held_at(&app, host.trim(), card.trim(), kept.as_deref(), path.as_deref(), None)?;
    if let Some((_, bytes)) = crate::off_main(move || seeing::read_held(&at)).await? {
        return Ok(Measured { size: crate::show::picture_size(&bytes), too_large: false });
    }
    let (l, host, card) = ready(&app, &host, &card).await?;
    let ask = Sight::Picture { call: None, n: 0, kept, path, measure: true, have: None };
    match l.read_see(&host, &card, ask, Duration::from_secs(20)).await? {
        SeeMsg::Seen { picture: Some(p), .. } => Ok(Measured { size: p.size, too_large: p.too_large }),
        _ => Err(format!("{host} did not say how large that picture is")),
    }
}

/// A picture one of another wall's cards showed or wrote in its prose, read
/// off that wall (`seeing.rs`) and checked here before it is drawn
/// (`seeing::received`).
///
/// **Kept here**, keyed by the wall, the card and what was asked: a kept
/// copy never changes, so one held here is drawn without asking again; a
/// picture by path is "the file as it is now", so the copy here is offered
/// back with its stamp and drawn only when the far wall says it has not moved.
/// If that wall cannot be asked, what is held here is drawn and says so.
///
/// `call` asks instead for the `n`th picture a tool call answered with
/// (`seeing.rs`, "And a picture a tool call answered with"), which never
/// changes and is kept here as a kept copy is.
#[tauri::command]
pub async fn flyway_see_picture(
    app: AppHandle,
    host: String,
    card: String,
    kept: Option<String>,
    path: Option<String>,
    call: Option<String>,
    n: Option<u32>,
) -> Result<Seen, String> {
    let _turn = turn().await?;
    let call = call.map(|c| c.trim().to_string()).filter(|c| !c.is_empty());
    let n = n.unwrap_or(0);
    let at = held_at(&app, host.trim(), card.trim(), kept.as_deref(), path.as_deref(), call.as_deref().map(|c| (c, n)))?;
    let read_at = at.clone();
    let held = crate::off_main(move || seeing::read_held(&read_at)).await?;
    if kept.is_some() || call.is_some() {
        if let Some((meta, bytes)) = &held {
            if !meta.stale {
                if let Some(s) = seen_from(meta, bytes, None) {
                    return Ok(s);
                }
            }
        }
    }
    let asked = async {
        let (l, host, card) = match &call {
            Some(_) => {
                let older = "cannot show the pictures its cards' tool calls answered with — update it there to see them here";
                ready_for(&app, &host, &card, seeing::CALL_WORD, older).await?
            }
            None => ready(&app, &host, &card).await?,
        };
        let ask = match &call {
            Some(c) => Sight::Picture { call: Some(c.clone()), n, kept: None, path: None, measure: false, have: None },
            None => {
                let have = if kept.is_none() { held.as_ref().and_then(|(m, _)| m.stamp.clone()) } else { None };
                Sight::Picture { call: None, n: 0, kept: kept.clone(), path: path.clone(), measure: false, have }
            }
        };
        let within = wire::carrying_within((crate::show::MAX_PICTURE as usize) / 3 * 4);
        match l.read_see(&host, &card, ask, within).await? {
            SeeMsg::Seen { picture: Some(p), .. } => Ok((host, p)),
            _ => Err(format!("{host} sent no picture")),
        }
    }
    .await;
    let (host, p) = match asked {
        Ok(it) => it,
        /* Not reachable just now: what this wall last read, said to be that. */
        Err(e) => {
            if let Some((meta, bytes)) = &held {
                let note = format!("as it was when last read from {} — {e}", host.trim());
                if let Some(s) = seen_from(meta, bytes, Some(note)) {
                    return Ok(s);
                }
            }
            return Err(e);
        }
    };
    if p.same {
        if let Some((meta, bytes)) = &held {
            if let Some(s) = seen_from(meta, bytes, None) {
                /* Touched, so the budget sweep takes it last. */
                let a = at.clone();
                let _ = crate::off_main(move || {
                    let _ = std::fs::File::options().append(true).open(&a).and_then(|f| f.set_modified(std::time::SystemTime::now()));
                })
                .await;
                return Ok(s);
            }
        }
    }
    let stale = p.stale;
    let stamp = p.stamp.clone();
    let name = p.name.clone();
    let h = host.clone();
    let checked = crate::off_main(move || seeing::received(&p, &h)).await??;
    let Some(data) = checked.data else {
        return Ok(Seen {
            data_url: String::new(),
            bytes: checked.bytes,
            too_large: true,
            path: String::new(),
            size: checked.size,
            stale,
            note: None,
        });
    };
    let out = Seen {
        data_url: format!("data:{};base64,{}", crate::show::mime(checked.kind), crate::base64(&data)),
        bytes: checked.bytes,
        too_large: false,
        path: String::new(),
        size: checked.size,
        stale,
        note: None,
    };
    /* A stale kept copy is the file as it is now, not the copy: not kept
       under the copy's key, which promises never to change. */
    if !stale {
        let meta = Held { name, stamp, stale: false };
        let _ = crate::off_main(move || {
            if seeing::write_held(&at, &meta, &data).is_ok() {
                if let (Some(dir), Some(spare)) = (at.parent(), at.file_name().and_then(|n| n.to_str())) {
                    crate::show::sweep(dir, PICTURES_BUDGET, spare);
                }
            }
        })
        .await;
    }
    Ok(out)
}

/// A file one of another wall's cards named, pulled whole and written into a
/// folder of this wall's own for the viewer to read — a copy, which the viewer
/// is told so it offers nothing that would edit it.
#[derive(Serialize)]
pub struct Fetched {
    /// The folder the copy is in, and its name — what the viewer reads.
    root: String,
    path: String,
    /// Where it is on that wall, in that wall's spelling.
    full: String,
    host: String,
}

#[tauri::command]
pub async fn flyway_see_file(app: AppHandle, host: String, card: String, path: String) -> Result<Fetched, String> {
    static PULLS: std::sync::OnceLock<tokio::sync::Semaphore> = std::sync::OnceLock::new();
    let _turn = PULLS
        .get_or_init(|| tokio::sync::Semaphore::new(2))
        .acquire()
        .await
        .map_err(|_| "this wall has stopped reading other walls' files".to_string())?;
    let (l, host, card) = ready(&app, &host, &card).await?;
    let mut g = seeing::Gathering::default();
    let mut from = 0u64;
    let within = wire::carrying_within(seeing::BUDGET);
    for _ in 0..seeing::ROUNDS_MOST {
        let part = match l.read_see(&host, &card, Sight::File { path: path.clone(), from }, within).await? {
            SeeMsg::Seen { part: Some(p), .. } => p,
            _ => return Err(format!("{host} sent none of that file")),
        };
        if g.take(part, &host)? {
            let key = seeing::key(&[&host.to_ascii_lowercase(), &card, &path]);
            let dir = files_dir(&app)?;
            let (name, full, bytes) = (g.name.clone(), g.full.clone(), std::mem::take(&mut g.got));
            let a = app.clone();
            return crate::off_main(move || {
                sweep_files(&a, false);
                let at = dir.join(key);
                let _ = std::fs::remove_dir_all(&at);
                std::fs::create_dir_all(&at).map_err(|e| format!("could not keep a copy here: {e}"))?;
                std::fs::write(at.join(&name), bytes).map_err(|e| format!("could not keep a copy here: {e}"))?;
                Ok(Fetched { root: at.to_string_lossy().into_owned(), path: name, full, host })
            })
            .await?;
        }
        from = g.got.len() as u64;
    }
    Err(format!("{host} took more exchanges than any file should"))
}

/// Take away the copies of other walls' files the viewer read. At launch
/// (`all`) all of them, since nothing is pointed at them across a restart; on
/// each pull, those more than a day old.
pub(super) fn sweep_files(app: &AppHandle, all: bool) {
    let Ok(root) = files_dir(app) else { return };
    if all {
        let _ = std::fs::remove_dir_all(&root);
        return;
    }
    let Ok(read) = std::fs::read_dir(&root) else { return };
    let day = Duration::from_secs(24 * 60 * 60);
    for e in read.flatten() {
        let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|a| a > day);
        if old {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}
