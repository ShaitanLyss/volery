//! Choosing what the wall plays — the two tools a card gets, and nothing else.
//!
//! Named for the role rather than the mechanism: in a sound system the
//! *selector* is the person who picks the records, and picking is the whole of
//! what this file does. The transport — play, pause, volume, skip — is
//! `spotify::spotify_command`, it already works, and **it is deliberately not
//! reachable from here.** That is the user's scoping, in their words: an agent
//! may choose what plays; it may not touch how loud their room is or silence
//! them mid-track. If a future tool in this file wants a transport verb "for
//! completeness", that is the instinct this file exists to refuse.
//!
//! ## Why the load leg needs no Web API
//!
//! Volery is a librespot Spirc connect device, so the obvious reading is that
//! selecting music means `PUT /v1/me/player/play` with a `device_id` — the Web
//! API's own remote-control endpoint. It does not. `Spirc::load` is exposed by
//! `librespot-connect` 0.8 and takes the same two shapes that endpoint does:
//! `from_context_uri` is its `context_uri`, `from_tracks` is its `uris` (the
//! crate's own doc comments say so). So a load is a local call on a handle this
//! app already holds — no second network round trip, no device-id juggling, and
//! no dependency on the account being Premium *for the load itself*.
//!
//! **Search is the other way round.** `SpClient` has `get_metadata`,
//! `get_context`, `get_playlist` and `get_radio_for_track` and no catalogue
//! search of any kind, so there is nothing to reach for locally: `records` is a
//! real `GET /v1/search` against `api.spotify.com`. That is the whole reason
//! this file has an HTTP path at all.
//!
//! ## The one judgement call, stated where it can be found
//!
//! `start_playing` is a *field* on `LoadRequestOptions` and defaults to false,
//! so loading does not inherently start playback and the user's exclusion is
//! honourable as written. But a load replaces the current context and track, so
//! it is not transport-neutral either: dropping a record onto a deck that is
//! spinning takes off what was playing. librespot 0.8 offers no way out —
//! `AddToQueue` exists in `spirc.rs` but only as an *inbound* dealer command,
//! something a Spotify client tells us, so "queue it after this track" is not
//! available to build on.
//!
//! So the rule is: **refuse while something is actually playing, and otherwise
//! load and start.** Both halves are the same argument. If the room is silent,
//! putting something on interrupts nothing and "put something on" ought to mean
//! music starts, or the tool is a no-op an agent cannot tell from success. If
//! the room is not silent, the user is listening to something and an agent does
//! not get to take it off. The refusal names the track it is protecting and
//! tells the caller to ask, which keeps the person in the loop by design rather
//! than by hoping.
//!
//! The cost of that rule, so nobody has to rediscover it: a *paused* track
//! counts as silent, so a load loses the position the user had paused at. That
//! is the one real loss and it is deliberate — treating paused as busy would
//! make the tool refuse almost always, since a device that has ever played sits
//! paused for the rest of the day.

use serde_json::{json, Value};
use tauri::AppHandle;

/* ── the two names ─────────────────────────────────────────────────────────*/

/// Search the catalogue. Reading, and it touches nobody's listening.
pub const RECORDS_TOOL: &str = "records";

/// Put something on. The only tool in the app that changes what the user hears,
/// and it is bounded by `refuse_while_playing` rather than by good intentions.
pub const PUT_ON_TOOL: &str = "put_on";

/* ── bounds ────────────────────────────────────────────────────────────────*/

/// How many hits per kind when nobody said.
///
/// Small on purpose. An agent asking "is there a Kind of Blue on here" wants
/// the top few, and the failure this avoids is spending a card's context on
/// fifty near-identical remasters. `limit` can raise it and `MAX_LIMIT` caps it.
const DEFAULT_LIMIT: usize = 8;

/// The ceiling, whatever was asked for. The Web API's own maximum is 50; this
/// is lower for the reason `DEFAULT_LIMIT` is low — the answer is read by
/// something that pays per token.
const MAX_LIMIT: usize = 20;

/// What `records` searches when nobody narrows it.
///
/// Artists are left out of the default deliberately: an artist hit is not
/// something you can put on and expect a particular record, so leading with
/// them answers a different question than the one usually being asked. `types`
/// can ask for them.
const DEFAULT_TYPES: &str = "track,album,playlist";

/// Every type the Web API's `q` search accepts, which is also every kind
/// `normalize_uri` will take. Kept as one list so the two cannot drift.
const KINDS: &[&str] = &["track", "album", "playlist", "artist", "show", "episode"];

/* ── percent-encoding ──────────────────────────────────────────────────────
 *
 * By hand rather than by a crate, because this is the only place in the app
 * that needs it and a dependency for eleven lines is a dependency to keep
 * current. Unreserved set per RFC 3986 — everything else goes to %XX, which is
 * safe in a query string in a way that `+` for space is not (`+` is only space
 * in `application/x-www-form-urlencoded`, and this is a URL query). */

fn encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/* ── what a card is allowed to name ───────────────────────────────────────*/

/// Turn whatever an agent pasted into a canonical `spotify:kind:id`.
///
/// Three shapes arrive in practice and all three are accepted, because the one
/// an agent has is whichever the user copied and refusing two of them would be
/// a puzzle rather than a boundary:
///
/// - `spotify:album:1weenld61qoidwYuZ1GESA` — the URI proper, what `records`
///   answers with.
/// - `https://open.spotify.com/album/1weenld61qoidwYuZ1GESA?si=...` — what the
///   share button gives you. The `?si=` tracking parameter is dropped.
/// - `https://open.spotify.com/intl-de/album/1weenld...` — the same with a
///   locale segment, which Spotify started inserting and which is easy to miss
///   because it only appears for some users. Any `intl-*` segment is skipped.
///
/// The id is checked for shape but not for length: 22 base-62 characters is the
/// usual thing, and hard-coding it would reject a kind whose ids Spotify sizes
/// differently — a bound that buys nothing and breaks silently later.
pub(crate) fn normalize_uri(input: &str) -> Result<(String, String), String> {
    let raw = input.trim();
    if raw.is_empty() {
        return Err("no uri was given — `mcp__skein__records` answers with the ones to use"
            .into());
    }

    let (kind, id) = if let Some(rest) = raw.strip_prefix("spotify:") {
        let mut parts = rest.split(':');
        let kind = parts.next().unwrap_or("").to_string();
        let id = parts.next().unwrap_or("").to_string();
        (kind, id)
    } else {
        let path = raw
            .trim_start_matches("https://")
            .trim_start_matches("http://")
            .trim_start_matches("open.spotify.com/");
        if path == raw && !raw.starts_with("open.spotify.com/") {
            return Err(format!(
                "{raw:?} is not a spotify uri or link — expected something like \
                 spotify:album:1weenld61qoidwYuZ1GESA, or the open.spotify.com \
                 link the share button gives you"
            ));
        }
        let mut segs = path
            .split('?')
            .next()
            .unwrap_or("")
            .split('/')
            .filter(|s| !s.is_empty() && !s.starts_with("intl-"));
        let kind = segs.next().unwrap_or("").to_string();
        let id = segs.next().unwrap_or("").to_string();
        (kind, id)
    };

    if !KINDS.contains(&kind.as_str()) {
        return Err(format!(
            "{:?} is not something that can be put on — expected one of {}",
            kind,
            KINDS.join(", ")
        ));
    }
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(format!("{id:?} is not a spotify id"));
    }
    Ok((kind.clone(), format!("spotify:{kind}:{id}")))
}

/// Whether a kind is a *context* — a thing with tracks in it — or a single item.
///
/// This is the choice between `LoadRequest::from_context_uri` and
/// `from_tracks`, and getting it the wrong way round does not fail loudly: a
/// track handed to `from_context_uri` is a context Spotify cannot resolve, and
/// an album handed to `from_tracks` is one track. `artist` counts as a context
/// because Spotify resolves an artist URI to their popular tracks, which is
/// what "put on some Coltrane" means.
pub(crate) fn is_context(kind: &str) -> bool {
    matches!(kind, "album" | "playlist" | "artist" | "show")
}

/* ── the search url ────────────────────────────────────────────────────────*/

/// `market=from_token` is not decoration: without it the answer includes
/// records that are not licensed where the user is, which are exactly the ones
/// that fail at load time with nothing useful to say. Scoping to the token's
/// own country means a hit that came back is a hit that can be put on.
pub(crate) fn search_url(query: &str, types: &str, limit: usize) -> String {
    format!(
        "https://api.spotify.com/v1/search?q={}&type={}&limit={}&market=from_token",
        encode(query),
        encode(types),
        limit.clamp(1, MAX_LIMIT)
    )
}

/// Narrow whatever `types` the caller asked for down to what the API accepts,
/// keeping their order. An unknown word is dropped rather than refused — a
/// model writing `songs` for `track` should get music, not a schema lecture —
/// and dropping everything falls back to the default rather than searching for
/// nothing.
pub(crate) fn clean_types(asked: Option<&str>) -> String {
    let Some(asked) = asked else {
        return DEFAULT_TYPES.to_string();
    };
    let kept: Vec<&str> = asked
        .split(',')
        .map(|s| s.trim())
        .filter(|s| KINDS.contains(s))
        .collect();
    if kept.is_empty() {
        DEFAULT_TYPES.to_string()
    } else {
        kept.join(",")
    }
}

/* ── reading the answer ────────────────────────────────────────────────────*/

/// One row of a search answer, flattened out of whichever bucket it came from
/// so rendering does not need to know four shapes.
/// Serialises because the widget's own search draws these directly — the same
/// rows `records` renders into prose for a card. One parse, two faces.
#[derive(Debug, PartialEq, serde::Serialize)]
pub(crate) struct Hit {
    pub kind: String,
    pub uri: String,
    pub title: String,
    /// Who it is by — artists, or a playlist's owner. Empty when the kind has
    /// no such thing.
    pub by: String,
    /// The one extra fact worth a token: an album's year, a track's duration, a
    /// playlist's length.
    pub extra: String,
}

fn str_at(v: &Value, key: &str) -> String {
    v.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string()
}

fn artists_of(v: &Value) -> String {
    v.get("artists")
        .and_then(|a| a.as_array())
        .map(|a| {
            a.iter()
                .map(|x| str_at(x, "name"))
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default()
}

/// Milliseconds as `m:ss`, which is how a track length is read everywhere else.
pub(crate) fn fmt_ms(ms: u64) -> String {
    let total = ms / 1000;
    format!("{}:{:02}", total / 60, total % 60)
}

/// Flatten `GET /v1/search`'s four buckets into rows.
///
/// **Every field is read defensively and every item is allowed to be `null`**,
/// which is not paranoia about JSON in general but about this endpoint in
/// particular: Spotify's search returns literal `null` entries inside
/// `playlists.items` for playlists it will not describe, and an unwrapping
/// reader panics on a perfectly ordinary query. A row that cannot be described
/// is dropped rather than rendered half-empty — a hit with no uri is one an
/// agent cannot act on anyway.
pub(crate) fn parse_hits(body: &Value) -> Vec<Hit> {
    let mut out = Vec::new();

    let bucket = |key: &str| -> Vec<Value> {
        body.get(key)
            .and_then(|b| b.get("items"))
            .and_then(|i| i.as_array())
            .map(|a| a.iter().filter(|v| !v.is_null()).cloned().collect())
            .unwrap_or_default()
    };

    for t in bucket("tracks") {
        let album = t
            .get("album")
            .map(|a| str_at(a, "name"))
            .unwrap_or_default();
        let ms = t.get("duration_ms").and_then(|d| d.as_u64()).unwrap_or(0);
        let mut extra = String::new();
        if !album.is_empty() {
            extra.push_str(&album);
        }
        if ms > 0 {
            if !extra.is_empty() {
                extra.push_str(" · ");
            }
            extra.push_str(&fmt_ms(ms));
        }
        if t.get("explicit").and_then(|e| e.as_bool()) == Some(true) {
            extra.push_str(" · explicit");
        }
        out.push(Hit {
            kind: "track".into(),
            uri: str_at(&t, "uri"),
            title: str_at(&t, "name"),
            by: artists_of(&t),
            extra,
        });
    }

    for a in bucket("albums") {
        let year = str_at(&a, "release_date");
        let year = year.split('-').next().unwrap_or("").to_string();
        let n = a.get("total_tracks").and_then(|t| t.as_u64()).unwrap_or(0);
        let mut extra = year;
        if n > 0 {
            if !extra.is_empty() {
                extra.push_str(" · ");
            }
            extra.push_str(&format!("{n} tracks"));
        }
        out.push(Hit {
            kind: "album".into(),
            uri: str_at(&a, "uri"),
            title: str_at(&a, "name"),
            by: artists_of(&a),
            extra,
        });
    }

    for p in bucket("playlists") {
        let owner = p
            .get("owner")
            .map(|o| str_at(o, "display_name"))
            .unwrap_or_default();
        let n = p
            .get("tracks")
            .and_then(|t| t.get("total"))
            .and_then(|t| t.as_u64())
            .unwrap_or(0);
        out.push(Hit {
            kind: "playlist".into(),
            uri: str_at(&p, "uri"),
            title: str_at(&p, "name"),
            by: owner,
            extra: if n > 0 { format!("{n} tracks") } else { String::new() },
        });
    }

    for a in bucket("artists") {
        let followers = a
            .get("followers")
            .and_then(|f| f.get("total"))
            .and_then(|t| t.as_u64())
            .unwrap_or(0);
        out.push(Hit {
            kind: "artist".into(),
            uri: str_at(&a, "uri"),
            title: str_at(&a, "name"),
            by: String::new(),
            extra: if followers > 0 {
                format!("{followers} followers")
            } else {
                String::new()
            },
        });
    }

    for s in bucket("shows") {
        out.push(Hit {
            kind: "show".into(),
            uri: str_at(&s, "uri"),
            title: str_at(&s, "name"),
            by: str_at(&s, "publisher"),
            extra: String::new(),
        });
    }

    for e in bucket("episodes") {
        let ms = e.get("duration_ms").and_then(|d| d.as_u64()).unwrap_or(0);
        out.push(Hit {
            kind: "episode".into(),
            uri: str_at(&e, "uri"),
            title: str_at(&e, "name"),
            by: String::new(),
            extra: if ms > 0 { fmt_ms(ms) } else { String::new() },
        });
    }

    out.retain(|h| !h.uri.is_empty() && !h.title.is_empty());
    out
}

/// The answer text: the uri first on every line, because it is the part the
/// caller has to hand back to `put_on` and a uri buried behind prose is a uri
/// that gets retyped wrongly.
pub(crate) fn render_hits(query: &str, hits: &[Hit]) -> String {
    if hits.is_empty() {
        return format!(
            "nothing on spotify for {query:?}. try fewer words, or the artist's name \
             on its own — the search is Spotify's own and it does not guess."
        );
    }

    let mut out = format!("{} for {query:?}:\n", tally(hits));
    let mut shown = "";
    for h in hits {
        if h.kind != shown {
            out.push('\n');
            out.push_str(&format!("{}s\n", h.kind));
            shown = &h.kind;
        }
        let mut line = format!("  {}  {}", h.uri, h.title);
        if !h.by.is_empty() {
            line.push_str(&format!(" — {}", h.by));
        }
        if !h.extra.is_empty() {
            line.push_str(&format!(" · {}", h.extra));
        }
        out.push_str(&line);
        out.push('\n');
    }
    out.push_str(
        "\nput one on with `mcp__skein__put_on`, naming its uri. an album, playlist or \
         artist plays as a whole; a track plays on its own.",
    );
    out
}

/// "3 tracks, 2 albums" — counted per kind in the order they appear, so the
/// count reads in the same order as the list under it.
fn tally(hits: &[Hit]) -> String {
    let mut order: Vec<&str> = Vec::new();
    for h in hits {
        if !order.contains(&h.kind.as_str()) {
            order.push(&h.kind);
        }
    }
    order
        .into_iter()
        .map(|k| {
            let n = hits.iter().filter(|h| h.kind == k).count();
            format!("{n} {k}{}", if n == 1 { "" } else { "s" })
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/* ── the boundary ──────────────────────────────────────────────────────────*/

/// The whole of the transport restriction, in one function so it can be read
/// and tested as one thing.
///
/// `playing` is whether audio is actually coming out — not whether a track is
/// loaded, and not whether the session is up. Paused counts as silent; see the
/// module note for why that is deliberate and what it costs.
pub(crate) fn refuse_while_playing(playing: bool, now: Option<&str>) -> Option<String> {
    if !playing {
        return None;
    }
    let what = now
        .filter(|s| !s.is_empty())
        .map(|s| format!(" {s} is playing"))
        .unwrap_or_else(|| " something is playing".to_string());
    Some(format!(
        "not putting anything on —{what}, and taking it off is the user's to do, \
         not yours. this tool chooses music; it deliberately has no stop, pause, \
         skip or volume. if they asked you to change what is on, say what you \
         would put on and let them stop the current track — or ask them with \
         `mcp__skein__ask_user`. if the wall is quiet and you are seeing this, the track \
         finished a moment ago and it is worth trying once more."
    ))
}

/* ── searching ─────────────────────────────────────────────────────────────*/

/// One `GET /v1/search`.
///
/// `forge::agent` rather than a client of our own, and that is not laziness:
/// that agent exists because *this network intercepts TLS* and is built with
/// `native-certs` to survive it, and its own comment says duplicating it per
/// provider means two places to be wrong about a corporate proxy. Spotify is
/// the third caller and inherits the requirement rather than escaping it.
///
/// Blocking, and that is checked rather than assumed: `ask::start` gives every
/// MCP request its own thread, so a slow search parks the card that asked for
/// one and nothing else on the wall. **It must not become a
/// `#[tauri::command]`** without `async` — see the note in `ask.rs`'s handle
/// chain and `off_main` in `lib.rs`.
/// Search, for the wall's own face rather than for a card.
///
/// `records` renders its hits into prose because its reader is a language model
/// reading a tool result. A widget wants rows. So this shares every judgement
/// with it — `clean_types`, `search_url`, the limit clamp, `parse_hits` — and
/// differs only in stopping before the rendering, which is the part that is
/// about the audience rather than about Spotify.
///
/// `async`, so the network round trip goes through `off_main` and cannot hold
/// the thread that paints every card on the wall. See CLAUDE.md.
#[tauri::command]
pub async fn spotify_search(
    query: String,
    types: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<Hit>, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let types = clean_types(types.as_deref());
    let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);

    crate::off_main(move || {
        let token = crate::spotify::access_token()?;
        let body = fetch_search(&token, &search_url(&query, &types, limit))?;
        Ok(parse_hits(&body))
    })
    .await?
}

fn fetch_search(token: &str, url: &str) -> Result<Value, String> {
    match crate::forge::agent()
        .get(url)
        .set("Authorization", &format!("Bearer {token}"))
        .set("Accept", "application/json")
        .call()
    {
        Ok(res) => res
            .into_json::<Value>()
            .map_err(|e| format!("unreadable answer from spotify: {e}")),
        /* 401 here is a token that went stale between the cache check and the
           call, which is ordinary and worth saying plainly rather than as an
           http code. 403 is the interesting one: it is what a token minted for
           a client id the Web API does not recognise gets, and it is the
           failure mode nobody has ruled out yet — see the rule. */
        Err(ureq::Error::Status(401, _)) => {
            Err("spotify would not accept the sign-in — relink the account from the wall".into())
        }
        Err(ureq::Error::Status(403, res)) => {
            let body = res.into_string().unwrap_or_default();
            Err(format!(
                "spotify refused the search (403). this is the one leg nobody has \
                 proven: volery signs in with librespot's client id, and the web \
                 api may not accept it for /v1/search. {body}"
            ))
        }
        Err(ureq::Error::Status(429, _)) => {
            Err("spotify is rate-limiting this wall — wait a minute before searching again".into())
        }
        Err(ureq::Error::Status(code, res)) => {
            let body = res.into_string().unwrap_or_default();
            Err(format!("spotify answered {code}: {body}"))
        }
        Err(e) => Err(format!("could not reach spotify: {e}")),
    }
}

fn do_records(args: &Value) -> String {
    let Some(query) = args.get("query").and_then(|q| q.as_str()) else {
        return "say what to search for, in `query`.".to_string();
    };
    let query = query.trim();
    if query.is_empty() {
        return "say what to search for, in `query`.".to_string();
    }

    let types = clean_types(args.get("types").and_then(|t| t.as_str()));
    let limit = args
        .get("limit")
        .and_then(|l| l.as_u64())
        .map(|l| l as usize)
        .unwrap_or(DEFAULT_LIMIT);

    let token = match crate::spotify::access_token() {
        Ok(t) => t,
        Err(why) => return why,
    };

    match fetch_search(&token, &search_url(query, &types, limit)) {
        Ok(body) => render_hits(query, &parse_hits(&body)),
        Err(why) => why,
    }
}

/* ── putting something on ──────────────────────────────────────────────────*/

fn do_put_on(app: &AppHandle, args: &Value) -> String {
    let Some(raw) = args.get("uri").and_then(|u| u.as_str()) else {
        return "say what to put on, in `uri` — `mcp__skein__records` answers with the \
                ones to use."
            .to_string();
    };

    let (kind, uri) = match normalize_uri(raw) {
        Ok(pair) => pair,
        Err(why) => return why,
    };

    match crate::spotify::put_on(app, &uri, is_context(&kind)) {
        Ok(said) => said,
        Err(why) => why,
    }
}

/* ── routing ───────────────────────────────────────────────────────────────*/

/// Route a `tools/call`, or `None` so `ask.rs` can try the next module — the
/// same contract `servers::handle` has.
///
/// Both arms answer on the calling thread, and `records` makes a network call
/// there. That is the same bargain `servers::handle` documents at length and it
/// holds for the same reason: one thread per request, so this parks only the
/// card that asked.
pub fn handle(app: &AppHandle, _conversation_id: &str, tool: &str, args: &Value) -> Option<String> {
    match tool {
        RECORDS_TOOL => Some(do_records(args)),
        PUT_ON_TOOL => Some(do_put_on(app, args)),
        _ => None,
    }
}

/* ── the schemas ───────────────────────────────────────────────────────────*/

pub fn records_schema() -> Value {
    json!({
        "name": RECORDS_TOOL,
        "description":
            "Search Spotify's catalogue for something to put on — a track, an album, a \
             playlist, an artist. Reading only: it changes nothing about what the user is \
             hearing, so it is always safe to call.\n\n\
             Answers each hit with its `spotify:` uri first, which is what `put_on` \
             takes. Prefer searching to guessing a uri: an id you invented is a load that \
             fails, and the search is Spotify's own so it is the only thing that knows \
             what exists.\n\n\
             Scoped to the user's own country, so anything that comes back is something \
             that can actually be played here. Narrow with `types` when you know the \
             shape of what you want — asking for `album` when the user said 'put on Kind \
             of Blue' avoids a page of individual tracks off it.\n\n\
             Works whether or not the wall's player is running, since a search is a \
             question about the catalogue rather than about the device.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description":
                        "What to search for, in Spotify's own search language — free text \
                         works ('kind of blue miles davis'), and so do its field filters \
                         (`artist:coltrane year:1965`, `album:'a love supreme'`)."
                },
                "types": {
                    "type": "string",
                    "description":
                        "Comma-separated kinds to search, from track, album, playlist, \
                         artist, show, episode. Defaults to track,album,playlist — \
                         artists are left out by default because an artist is not a \
                         particular record. An unrecognised word is ignored rather than \
                         refused."
                },
                "limit": {
                    "type": "integer",
                    "description":
                        "Hits per kind, default 8, capped at 20. Raise it only when the \
                         obvious answer was not in the first few — a long list is context \
                         you are paying for."
                }
            },
            "required": ["query"]
        }
    })
}

pub fn put_on_schema() -> Value {
    json!({
        "name": PUT_ON_TOOL,
        "description":
            "Put something on the wall's Spotify — a track, album, playlist or artist, by \
             its `spotify:` uri. Get the uri from `records` rather than composing one.\n\n\
             **This chooses music and nothing else. There is deliberately no pause, stop, \
             skip or volume anywhere in this server**, because the user keeps control of \
             their own listening. Do not look for one, and do not ask for one to be added \
             — the absence is the design.\n\n\
             **It refuses while something is playing.** If the user is listening to \
             something, taking it off is theirs to do, so this answers with a refusal \
             naming the track rather than replacing it. When the wall is quiet it loads \
             the selection and starts it, which is the whole of what 'put something on' \
             means. So the honest pattern when music is already on is: say what you would \
             put on, and let them stop what is playing — or ask them with `ask_user`.\n\n\
             An album, playlist or artist plays as a whole; a track plays on its own. \
             Needs the wall's player to be running and an account linked, both of which \
             are the user's to set up from the wall — if it is not up, say so rather than \
             trying to start it, since starting a player is not a thing a card can do.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "uri": {
                    "type": "string",
                    "description":
                        "What to put on: `spotify:album:1weenld61qoidwYuZ1GESA`, or the \
                         open.spotify.com link the share button gives you — both are \
                         accepted, and a `?si=` tracking parameter or an `intl-xx` locale \
                         segment in a pasted link is ignored."
                }
            },
            "required": ["uri"]
        }
    })
}

/* ── tests ─────────────────────────────────────────────────────────────────
 *
 * `cargo test` does not run on this machine (no MSVC — see
 * `.claude/rules/build.md`), so these are written to be liftable: every
 * function under test is pure and needs nothing from the crate but
 * `serde_json`. `tools/lift-selector.ts` regenerates the throwaway and runs
 * them with `rustc --test`. */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_uri_survives_being_a_uri() {
        let (kind, uri) = normalize_uri("spotify:album:1weenld61qoidwYuZ1GESA").unwrap();
        assert_eq!(kind, "album");
        assert_eq!(uri, "spotify:album:1weenld61qoidwYuZ1GESA");
    }

    /// The share button's link, tracking parameter and all. This is the shape a
    /// user actually pastes, so it is the one most likely to arrive.
    #[test]
    fn a_share_link_loses_its_tracking_parameter() {
        let (kind, uri) =
            normalize_uri("https://open.spotify.com/track/4vLYewWIvqHfKtJDk8c8tq?si=abc123")
                .unwrap();
        assert_eq!(kind, "track");
        assert_eq!(uri, "spotify:track:4vLYewWIvqHfKtJDk8c8tq");
    }

    /// The locale segment Spotify inserts for some users and not others —
    /// exactly the kind of thing that works on one machine and not the next.
    #[test]
    fn an_intl_segment_is_skipped() {
        let (_, uri) =
            normalize_uri("https://open.spotify.com/intl-de/album/1weenld61qoidwYuZ1GESA").unwrap();
        assert_eq!(uri, "spotify:album:1weenld61qoidwYuZ1GESA");
    }

    #[test]
    fn a_bare_host_is_still_a_link() {
        let (_, uri) = normalize_uri("open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M").unwrap();
        assert_eq!(uri, "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M");
    }

    #[test]
    fn nonsense_is_refused_with_an_example() {
        let err = normalize_uri("kind of blue").unwrap_err();
        assert!(err.contains("spotify:album:"), "{err}");
    }

    #[test]
    fn a_kind_that_cannot_be_played_is_refused() {
        let err = normalize_uri("spotify:user:someone").unwrap_err();
        assert!(err.contains("not something that can be put on"), "{err}");
    }

    #[test]
    fn an_empty_uri_points_at_records() {
        assert!(normalize_uri("   ").unwrap_err().contains("records"));
    }

    /// The distinction that decides `from_context_uri` versus `from_tracks`,
    /// and gets no loud failure if it is wrong.
    #[test]
    fn contexts_are_the_things_with_tracks_in_them() {
        for k in ["album", "playlist", "artist", "show"] {
            assert!(is_context(k), "{k} should be a context");
        }
        for k in ["track", "episode"] {
            assert!(!is_context(k), "{k} should not be a context");
        }
    }

    #[test]
    fn a_query_is_encoded_for_a_query_string() {
        let url = search_url("miles davis & 'round midnight", "track", 5);
        assert!(url.contains("q=miles%20davis%20%26%20%27round%20midnight"), "{url}");
        /* Not `+`: that is only a space in form encoding, and this is a URL. */
        assert!(!url.contains('+'), "{url}");
    }

    #[test]
    fn the_limit_is_clamped_both_ways() {
        assert!(search_url("x", "track", 999).contains("limit=20"));
        assert!(search_url("x", "track", 0).contains("limit=1"));
    }

    #[test]
    fn the_market_is_the_users_own() {
        assert!(search_url("x", "track", 5).contains("market=from_token"));
    }

    #[test]
    fn unknown_types_fall_back_rather_than_refusing() {
        assert_eq!(clean_types(Some("songs,records")), DEFAULT_TYPES);
        assert_eq!(clean_types(None), DEFAULT_TYPES);
        assert_eq!(clean_types(Some("album, track")), "album,track");
        assert_eq!(clean_types(Some("album,nonsense")), "album");
    }

    #[test]
    fn a_track_reads_with_its_album_and_length() {
        let body = json!({
            "tracks": { "items": [{
                "uri": "spotify:track:1", "name": "So What",
                "artists": [{ "name": "Miles Davis" }],
                "album": { "name": "Kind of Blue" },
                "duration_ms": 562_000
            }]}
        });
        let hits = parse_hits(&body);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "So What");
        assert_eq!(hits[0].by, "Miles Davis");
        assert_eq!(hits[0].extra, "Kind of Blue · 9:22");
    }

    /// The quirk that panics an unwrapping reader on an ordinary query.
    #[test]
    fn a_null_playlist_does_not_take_the_answer_with_it() {
        let body = json!({
            "playlists": { "items": [
                null,
                { "uri": "spotify:playlist:2", "name": "Late Night Jazz",
                  "owner": { "display_name": "Spotify" },
                  "tracks": { "total": 80 } }
            ]}
        });
        let hits = parse_hits(&body);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "Late Night Jazz");
        assert_eq!(hits[0].extra, "80 tracks");
    }

    /// A hit an agent could not act on is worse than one fewer hit.
    #[test]
    fn a_row_with_no_uri_is_dropped() {
        let body = json!({ "tracks": { "items": [{ "name": "nameless" }] } });
        assert!(parse_hits(&body).is_empty());
    }

    #[test]
    fn missing_buckets_are_not_an_error() {
        assert!(parse_hits(&json!({})).is_empty());
        assert!(parse_hits(&json!({ "tracks": {} })).is_empty());
        assert!(parse_hits(&json!({ "tracks": { "items": null } })).is_empty());
    }

    #[test]
    fn an_album_reads_with_its_year() {
        let body = json!({
            "albums": { "items": [{
                "uri": "spotify:album:3", "name": "A Love Supreme",
                "artists": [{ "name": "John Coltrane" }],
                "release_date": "1965-01-01", "total_tracks": 4
            }]}
        });
        let hits = parse_hits(&body);
        assert_eq!(hits[0].extra, "1965 · 4 tracks");
    }

    #[test]
    fn durations_read_as_minutes_and_seconds() {
        assert_eq!(fmt_ms(0), "0:00");
        assert_eq!(fmt_ms(9_000), "0:09");
        assert_eq!(fmt_ms(69_000), "1:09");
        assert_eq!(fmt_ms(562_000), "9:22");
        assert_eq!(fmt_ms(3_600_000), "60:00");
    }

    /// The uri has to be the first thing on the line — it is the part that gets
    /// handed back, and one buried behind prose is one that gets retyped wrongly.
    #[test]
    fn the_uri_leads_every_line() {
        let hits = vec![Hit {
            kind: "album".into(),
            uri: "spotify:album:3".into(),
            title: "A Love Supreme".into(),
            by: "John Coltrane".into(),
            extra: "1965".into(),
        }];
        let out = render_hits("coltrane", &hits);
        let row = out
            .lines()
            .find(|l| l.contains("A Love Supreme"))
            .expect("the album should be listed");
        assert!(row.trim_start().starts_with("spotify:album:3"), "{row}");
        assert!(out.contains("1 album for"), "{out}");
        assert!(out.contains("put_on"), "{out}");
    }

    #[test]
    fn nothing_found_says_so_without_pretending() {
        let out = render_hits("asdfghjkl", &[]);
        assert!(out.contains("nothing on spotify"), "{out}");
        assert!(!out.contains("put_on"), "{out}");
    }

    #[test]
    fn the_tally_counts_per_kind_and_pluralises() {
        let hit = |kind: &str, uri: &str| Hit {
            kind: kind.into(),
            uri: uri.into(),
            title: "t".into(),
            by: String::new(),
            extra: String::new(),
        };
        let hits = vec![
            hit("track", "spotify:track:1"),
            hit("track", "spotify:track:2"),
            hit("album", "spotify:album:1"),
        ];
        assert!(render_hits("x", &hits).contains("2 tracks, 1 album for"));
    }

    /* ── the boundary ──────────────────────────────────────────────────── */

    #[test]
    fn a_quiet_wall_may_be_played_to() {
        assert!(refuse_while_playing(false, None).is_none());
        assert!(refuse_while_playing(false, Some("So What")).is_none());
    }

    #[test]
    fn a_playing_wall_is_left_alone() {
        let said = refuse_while_playing(true, Some("So What — Miles Davis")).unwrap();
        assert!(said.contains("So What"), "{said}");
        assert!(said.contains("the user's to do"), "{said}");
    }

    /// The refusal must not merely say no — an agent told only "no" tries a
    /// different phrasing of the same call. It names the way forward, which is
    /// the lesson `MAX_HOPS` and the board's own refusal both record.
    #[test]
    fn the_refusal_carries_a_way_forward() {
        let said = refuse_while_playing(true, None).unwrap();
        assert!(said.contains("ask_user"), "{said}");
        assert!(said.contains("something is playing"), "{said}");
    }

    /// The scoping restated where a future edit would trip over it: neither
    /// description may offer a transport verb, however convenient.
    #[test]
    fn no_schema_offers_a_transport_verb() {
        let both = format!("{}{}", records_schema(), put_on_schema());
        let props = format!(
            "{}{}",
            records_schema()["inputSchema"]["properties"],
            put_on_schema()["inputSchema"]["properties"]
        );
        for verb in ["pause", "volume", "skip", "stop"] {
            assert!(
                !props.to_lowercase().contains(verb),
                "{verb} must not be an argument of a selection tool"
            );
        }
        /* The words may appear in prose — `put_on` promises their absence — so
           the assertion above is about arguments, and this one is about the
           promise being made at all. */
        assert!(both.contains("no pause, stop, skip or volume"), "{both}");
    }

    #[test]
    fn both_tools_are_named_and_described() {
        for s in [records_schema(), put_on_schema()] {
            assert!(s["name"].as_str().is_some_and(|n| !n.is_empty()));
            assert!(s["description"].as_str().is_some_and(|d| d.len() > 200));
            assert_eq!(s["inputSchema"]["type"], "object");
        }
        assert_eq!(records_schema()["name"], RECORDS_TOOL);
        assert_eq!(put_on_schema()["name"], PUT_ON_TOOL);
    }
}
