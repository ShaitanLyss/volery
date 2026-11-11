//! The flyway's directory: one shared record that says which walls are on it,
//! so a wall needs nobody's name to find everybody.
//!
//! ### Why a name was ever needed
//!
//! A wall's network identity is the key and the machine's name
//! (`WallKey::node_secret`). Holding the key means you can work out any wall's
//! address, but only once you know what it is called, and the key does not say
//! which names exist. So names came from the invite's seed, the roster, a
//! dial-in, and since 0.96.8 the names a wall kept (`here::KNOWN_WALLS`). Every
//! one of those needs the walls to have met. A wall that has never been up at
//! the same time as anyone now online (a newcomer whose inviter is off, a
//! machine back after a long absence) still has nobody to call.
//!
//! ### The meeting place
//!
//! Every wall already publishes a small signed record of its own to iroh's
//! pkarr relay, `dns.iroh.link`, which is how others find its relay. This is
//! one more record there, signed by a key every wall derives from the flyway
//! key (`secret`). All of them derive the same one and nobody without the
//! flyway key can, so only members can write it. Its content is the list of
//! wall names, sealed with the flyway key (`WallKey::seal`, room `directory`),
//! so the relay holds ciphertext and no name appears there. What the relay can
//! see is that the record exists and when it changes.
//!
//! ### Each wall writes only itself
//!
//! A wall reads the list, dials everyone on it, and writes it back only to add
//! its own name or to renew a record that has not been written for an hour
//! (`wanted`). It never adds another wall's name. Two walls writing at the same
//! moment can drop one name for one round, since the relay keeps the newest
//! record whole. The dropped wall sees itself missing on its next read and adds
//! itself back, so the list fills in. Because nobody re-adds anybody else, a
//! name taken out stays out: a wall that leaves takes itself out (`withdrawn`),
//! and a person forgetting a wall takes it out (`without`).
//!
//! **A list that could not be read is never written over.** Reading fails for
//! many reasons (no network, a relay hiccup, a record a newer build wrote in a
//! shape this one cannot open), and answering any of them by writing a list of
//! one would erase everybody else. Only a relay saying the record does not
//! exist (`Read::Absent`) lets a wall start one.
//!
//! This sits beside the kept names, not instead of them. The kept names still
//! work when the relay is down, and the directory covers walls that never met.
//! Pure, apart from the sealing: `wire.rs` does the HTTP.

use std::collections::BTreeSet;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::seal::WallKey;

/// The record's name under the directory key's zone.
pub const RECORD: &str = "_volery";

/// How often a wall reads the directory. A read is one small HTTP request, and
/// a wall that added itself shows up for the others within this.
pub const EVERY: Duration = Duration::from_secs(5 * 60);

/// A record nobody has written for this long is written again, unchanged, by
/// the first wall to read it, so the relay never lets it lapse.
pub const RENEW_AFTER_MICROS: u64 = 60 * 60 * 1_000_000;

/// The record's time to live, for anyone resolving it over DNS. Walls read it
/// over HTTP and ignore this.
pub const TTL: u32 = 300;

const ROOM: &str = "directory";
const SIGN_SALT: &[u8] = b"volery/flyway/directory/v1";
const SIGN_INFO: &[u8] = b"signing";
const VERSION: u32 = 1;

/// A TXT string holds at most 255 bytes; the rest is the `NN:` order prefix.
const CHUNK: usize = 250;

/// What the relay accepts for the DNS packet, from `iroh-dns`.
const PACKET_MOST: usize = 1000;

/// The longest name kept, as `here::learn_walls` caps one. Public because the
/// phone clips a name it took off a roster the same way before storing it.
pub const NAME_MOST: usize = 40;

/// The directory's signing secret, the same on every wall holding this key.
/// Derived under a salt of its own, so it has no fixed relationship to the
/// key that seals traffic or to any wall's node secret.
pub fn secret(key: &WallKey) -> Result<[u8; 32], String> {
    key.derive(SIGN_SALT, SIGN_INFO)
}

#[derive(Serialize, Deserialize)]
struct Body {
    v: u32,
    walls: Vec<String>,
}

/// What a read found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Read {
    /// The relay says there is no record. The one answer that lets a wall
    /// start one.
    Absent,
    /// The record, opened, and when it was written (microseconds).
    Found { walls: BTreeSet<String>, at_micros: u64 },
    /// Anything else. Dial nobody new, and write nothing.
    Unreadable,
}

/// The record's TXT strings for `walls`: the list sealed, in base64, split into
/// numbered strings so their order survives the DNS packet. Names that would
/// not fit the relay's ceiling are left out, `me` last of all, since a record
/// without its writer is one that writer will just add itself to again.
pub fn encode(key: &WallKey, walls: &BTreeSet<String>, me: &str) -> Result<Vec<String>, String> {
    let mut keep: Vec<String> = walls.iter().filter(|w| !w.eq_ignore_ascii_case(me)).cloned().collect();
    let mine = walls.iter().find(|w| w.eq_ignore_ascii_case(me)).cloned();
    loop {
        let mut list = keep.clone();
        list.extend(mine.clone());
        list.sort();
        let values = seal(key, list)?;
        if fits(&values) {
            return Ok(values);
        }
        if keep.pop().is_none() {
            return Err("the directory record is too large even with one name".to_string());
        }
    }
}

fn seal(key: &WallKey, walls: Vec<String>) -> Result<Vec<String>, String> {
    let body = serde_json::to_vec(&Body { v: VERSION, walls }).map_err(|e| e.to_string())?;
    let text = crate::base64(&key.seal(&key.room(ROOM), &body)?);
    Ok(text
        .as_bytes()
        .chunks(CHUNK)
        .enumerate()
        .map(|(i, c)| format!("{i:02}:{}", std::str::from_utf8(c).unwrap_or("")))
        .collect())
}

/// Whether these strings make a DNS packet the relay takes. Counted the way
/// `simple-dns` writes it: the header, the record name once in full, then each
/// record's compressed name, type, class, TTL, length and its one string.
fn fits(values: &[String]) -> bool {
    let header = 12;
    let name = 1 + RECORD.len() + 1 + 52 + 1;
    let each: usize = values.iter().map(|v| 2 + 10 + 1 + v.len()).sum();
    header + name + each <= PACKET_MOST
}

/// The list in a record's TXT strings, or `None` if they do not open under this
/// key or are not a list this build reads. Every name is put through
/// `clip::keep`, since a record is something another machine wrote.
pub fn decode(key: &WallKey, values: &[String]) -> Option<BTreeSet<String>> {
    let mut parts: Vec<(u32, &str)> = values
        .iter()
        .filter_map(|v| {
            let (i, rest) = v.split_once(':')?;
            Some((i.parse().ok()?, rest))
        })
        .collect();
    if parts.is_empty() {
        return None;
    }
    parts.sort_by_key(|(i, _)| *i);
    let text: String = parts.iter().map(|(_, s)| *s).collect();
    let body: Body = serde_json::from_slice(&key.open(&key.room(ROOM), &crate::unbase64(&text)?).ok()?).ok()?;
    if body.v != VERSION {
        return None;
    }
    Some(
        body.walls
            .iter()
            .filter(|w| !w.contains(['\n', '\r']))
            .map(|w| crate::clip::keep(w.trim(), NAME_MOST).kept)
            .filter(|w| !w.is_empty())
            .collect(),
    )
}

fn holds(walls: &BTreeSet<String>, name: &str) -> bool {
    walls.iter().any(|w| w.eq_ignore_ascii_case(name))
}

/// What this wall should write after reading `read`, or `None` for nothing:
/// a new record holding only itself, its own name added to the list, or the
/// list unchanged once it is old enough to need renewing.
pub fn wanted(read: &Read, me: &str, now_micros: u64) -> Option<BTreeSet<String>> {
    match read {
        Read::Unreadable => None,
        Read::Absent => Some(BTreeSet::from([me.to_string()])),
        Read::Found { walls, at_micros } => {
            if !holds(walls, me) {
                let mut more = walls.clone();
                more.insert(me.to_string());
                Some(more)
            } else if now_micros.saturating_sub(*at_micros) >= RENEW_AFTER_MICROS {
                Some(walls.clone())
            } else {
                None
            }
        }
    }
}

/// The list without `name`, if it was on it. For a wall leaving (its own name)
/// and a person forgetting one (another's). Nothing to write after a read that
/// found nothing or could not be opened.
pub fn without(read: &Read, name: &str) -> Option<BTreeSet<String>> {
    let Read::Found { walls, .. } = read else { return None };
    holds(walls, name).then(|| walls.iter().filter(|w| !w.eq_ignore_ascii_case(name)).cloned().collect())
}

/// The names in a read that a tick should dial: none at all unless it was
/// opened.
pub fn names(read: &Read) -> BTreeSet<String> {
    match read {
        Read::Found { walls, .. } => walls.clone(),
        _ => BTreeSet::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> WallKey {
        WallKey::from_bytes([7; 32])
    }

    fn set(n: &[&str]) -> BTreeSet<String> {
        n.iter().map(|s| s.to_string()).collect()
    }

    /// Every wall holding the key derives the same signing secret, and a wall
    /// on another key does not.
    #[test]
    fn every_wall_on_a_key_signs_as_one_and_another_key_does_not() {
        assert_eq!(secret(&key()).unwrap(), secret(&WallKey::from_bytes([7; 32])).unwrap());
        assert_ne!(secret(&key()).unwrap(), secret(&WallKey::from_bytes([8; 32])).unwrap());
        assert_ne!(secret(&key()).unwrap(), key().node_secret("directory").unwrap());
    }

    /// What one wall writes, another opens; no name is readable in the strings
    /// the relay holds; and another key opens nothing.
    #[test]
    fn a_record_opens_under_the_key_and_says_nothing_to_anyone_else() {
        let walls = set(&["AU-LT-285", "AU-LT-288", "QUEERISFREEDOM"]);
        let values = encode(&key(), &walls, "QUEERISFREEDOM").unwrap();
        assert!(values.iter().all(|v| !v.contains("AU-LT") && !v.contains("QUEER")));
        assert_eq!(decode(&key(), &values), Some(walls));
        assert_eq!(decode(&WallKey::from_bytes([8; 32]), &values), None);
        /* Out of order on the way back: the prefixes put it right. */
        let mut shuffled = values.clone();
        shuffled.reverse();
        assert_eq!(decode(&key(), &shuffled).map(|w| w.len()), Some(3));
        assert_eq!(decode(&key(), &["garbage".to_string()]), None);
        assert_eq!(decode(&key(), &[]), None);
    }

    /// Too many names for one record: the writer's own is the last to go, and
    /// what is left fits the relay's ceiling.
    #[test]
    fn a_list_too_large_for_the_relay_keeps_its_writer() {
        let mut walls: BTreeSet<String> = (0..80).map(|i| format!("a-machine-called-{i:03}")).collect();
        walls.insert("zz-me".to_string());
        let values = encode(&key(), &walls, "zz-me").unwrap();
        assert!(fits(&values));
        let back = decode(&key(), &values).unwrap();
        assert!(back.contains("zz-me"));
        assert!(back.len() > 10 && back.len() < 81, "kept {}", back.len());
        /* `fits` is an estimate; the builder the relay's ceiling actually
           lives in must agree with it, at the largest record `encode` makes,
           or every write of a full list would fail. */
        let signer = iroh::SecretKey::from_bytes(&secret(&key()).unwrap());
        let packet = iroh_dns::pkarr::SignedPacket::from_txt_strings(&signer, RECORD, &values, TTL)
            .expect("the largest record encode makes is one the relay's builder accepts");
        let opened = decode(&key(), &packet.txt_records(RECORD)).unwrap();
        assert_eq!(opened, back, "what is read back off the packet is what was written");
    }

    /// The whole of when a wall writes.
    #[test]
    fn a_wall_writes_only_to_start_the_list_add_itself_or_renew_it() {
        let now = 10 * RENEW_AFTER_MICROS;
        assert_eq!(wanted(&Read::Unreadable, "me", now), None, "a list that could not be read is never written over");
        assert_eq!(wanted(&Read::Absent, "me", now), Some(set(&["me"])));
        let fresh = Read::Found { walls: set(&["other"]), at_micros: now };
        assert_eq!(wanted(&fresh, "me", now), Some(set(&["me", "other"])));
        let mine = Read::Found { walls: set(&["ME", "other"]), at_micros: now - 1 };
        assert_eq!(wanted(&mine, "me", now), None, "already on it, in any case");
        let stale = Read::Found { walls: set(&["me", "other"]), at_micros: now - RENEW_AFTER_MICROS };
        assert_eq!(wanted(&stale, "me", now), Some(set(&["me", "other"])), "renewed unchanged");
    }

    /// Taking a name out, and nobody's name but the one asked for.
    #[test]
    fn a_name_comes_out_only_when_it_is_there() {
        let read = Read::Found { walls: set(&["me", "gone"]), at_micros: 0 };
        assert_eq!(without(&read, "GONE"), Some(set(&["me"])));
        assert_eq!(without(&read, "nobody"), None);
        assert_eq!(without(&Read::Absent, "me"), None);
        assert_eq!(without(&Read::Unreadable, "me"), None);
        assert_eq!(names(&Read::Unreadable), BTreeSet::new());
        assert_eq!(names(&read), set(&["gone", "me"]));
    }
}
