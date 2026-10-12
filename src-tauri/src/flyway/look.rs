//! What a question asked on another wall *shows*, carried to the wall the
//! person is at.
//!
//! The digest (`shadow.ts::DigestAsk`) carries a parked question's words, and
//! for a while that was all that crossed: a preview's markup was left behind as
//! code another wall would run, and a file's path as meaningless on another
//! machine. So a card on the home laptop asking "which of these three?" over
//! three screenshots reached Lyss at the work laptop as three labels and a
//! sentence saying only the other wall could show them (sink `77c043c6`,
//! `be3196fa`, `154a1637`). Her rule for the fix is the design: *"the remote
//! specific code should be as small as possible … I shouldn't discover shadow
//! card specific bugs that don't exist on normal cards."*
//!
//! ### So what crosses is the call, not a rendering of it
//!
//! The owning wall still holds the parked call's arguments (`ask.rs`'s
//! `Parked::args`), with every file already resolved to the `(root, path)`
//! pair the viewer reads. Those arguments go across whole, the files' bytes go
//! with them, and the wall that pulled them writes the bytes into a folder of
//! its own and points the same pairs there. Its front end then hands the
//! arguments to **the same `normalizeAsk`** a question asked here goes
//! through, and the dock, the gallery and the file viewer draw them exactly as
//! they draw a local card's — previews, files on an option, files on a
//! question, both forms. Nothing in the drawing knows the question came from
//! anywhere, which is the whole point: a difference that does not exist cannot
//! be a shadow-only bug.
//!
//! What is remote-specific is this file and the two arms in `link.rs` that
//! drive it — how the bytes travel — and nothing else.
//!
//! ### Pulled, never gossiped, and pulled at once
//!
//! A snapshot is re-sent to every peer whenever anything on a wall changes, so
//! a screenshot in it would be a screenshot sent dozens of times an hour. This
//! is `tail.rs`'s shape instead: one wall asks, the other answers on the same
//! stream, nothing is kept on the answering side and nothing retries by
//! itself. It is asked **the moment a question with something to show
//! arrives** (Lyss's choice, 2026-10-12) rather than when the panel opens, so
//! the pictures are there before anybody looks.
//!
//! ### In parts, so nothing is smaller than it is here
//!
//! A local question's file is read by `find::read_file_doc`, which carries up
//! to 24 MB. A frame is at most 8 MB (`wire::MAX_FRAME`). A lower limit for a
//! remote question would be exactly the kind of difference this exists to
//! remove, so a file crosses in as many exchanges as it needs: each answer
//! spends at most `BUDGET` characters on the arguments and base64 together,
//! the asker says where each file got to (`Want`), and the next answer carries
//! on from there. The same 24 MB is the ceiling on each file (`FILE_MOST`), and
//! a whole question stops at `ASK_MOST`. The arguments are the one thing not
//! sent in parts, and so the one limit a local question has not got
//! (`ARGS_MOST`).
//!
//! ### A file that does not arrive says so where it would have been
//!
//! Every `file` slot in the arguments that came across is **overwritten** on
//! the asking wall — with the pair it wrote, or with `{ path, fault }`, which
//! `normalizeAsk` keeps and `Gallery.svelte` draws on the panel the picture
//! would have filled. Too large, unreadable over there, changed while it was
//! being carried, stopped arriving: each is a sentence naming the file and the
//! wall. And a slot is never left as the other machine wrote it, because a
//! `root` from another wall is a path on *this* disk the viewer would read.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// The word a wall announces in `Facts::can` when it will answer a `look`. Not
/// one of `fleet::CAN`, for `tail::WORD`'s reason: a wall without it can still
/// be steered, and its questions still arrive — in words.
pub const WORD: &str = "look";

/// The most one file may be — `find::DOC_CAP`, the largest a question's file is
/// read at on its own wall. Past this the viewer there would refuse it too.
pub const FILE_MOST: u64 = 24 * 1024 * 1024;

/// The most one question's files may come to together. Twenty-four files at
/// the per-file ceiling would be half a gigabyte pulled for one sheet nobody
/// may open; this is four of them, which is past any real question.
pub const ASK_MOST: u64 = 96 * 1024 * 1024;

/// The most a question's arguments may be as text — **the one bound a local
/// question does not have**, said here so nobody reads the parts below as
/// parity everywhere. The arguments cross in one answer, and a preview with
/// base64 images inlined into its markup can pass this; such a question
/// stays words-only, with this number in its sentence. A sheet of twelve
/// decisions with a hand-written mockup on each option is a few hundred
/// kilobytes. Splitting the arguments into parts like a file is the fix if it
/// is ever met.
pub const ARGS_MOST: usize = 2 * 1024 * 1024;

/// What one answer may spend, in characters, on the arguments and the base64
/// together. Not sized to the 8 MB frame but to the exchange's twenty seconds
/// (`wire.rs`) over a slow relay: two megabytes there is ~100 KB/s, where five
/// timed out under 256 KB/s and lost the round (found in review).
pub const BUDGET: usize = 2 * 1024 * 1024;

/// How many exchanges one question may take. `ASK_MOST` at 1.5 MB of file a
/// round is sixty-four; this is the bound on a peer that keeps answering and
/// never finishes.
pub const ROUNDS_MOST: usize = 100;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "msg", rename_all = "snake_case")]
pub enum LookMsg {
    /// Ask for one parked question's arguments and files. `id` is the asker's
    /// and only ties the answer to the question in the exchange it was asked
    /// in. `want` empty is the first ask; after that it says where each file
    /// got to.
    Look {
        id: String,
        card: String,
        ask: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        want: Vec<Want>,
    },
    /// The answer. Optional fields rather than an enum of outcomes, for
    /// `tail::TailMsg::Tailed`'s reason: a field a newer build adds costs an
    /// older one nothing.
    Looked {
        id: String,
        /// The call's arguments, on the first answer only.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        args: Option<Value>,
        /// Every file the call carries, in `each_site` order, on every answer —
        /// a file that became unreadable since the last one says so here.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        files: Vec<Carried>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        parts: Vec<Part>,
        /// Why there is nothing at all — the question is gone, or not one
        /// that travels.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        why: Option<String>,
    },
}

/// Where the asker has got to with file `n`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Want {
    pub n: usize,
    pub from: u64,
}

/// One file as the owning wall found it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Carried {
    pub n: usize,
    pub name: String,
    pub size: u64,
    /// When the file was last written, in milliseconds, on the owning wall's
    /// clock — compared only with itself, so a file rewritten at the same size
    /// between two rounds is caught rather than arriving half old, half new.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stamp: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fault: Option<String>,
}

/// A run of one file's bytes, base64.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Part {
    pub n: usize,
    pub from: u64,
    pub data: String,
}

/// What the owning wall reads files through — the disk in `link.rs`, a map in
/// the tests.
pub trait Disk {
    /// The file's size and when it was last written, if the disk says.
    fn size(&mut self, root: &str, name: &str) -> Result<(u64, Option<u64>), String>;
    fn read(&mut self, root: &str, name: &str, from: u64, most: usize) -> Result<Vec<u8>, String>;
}

/// The `(root, path)` of every file a call carries, in `each_site` order —
/// the numbering both walls match a file by. A slot that is not a pair is
/// still counted, as an empty one, so the numbers cannot shift under it.
pub fn files_in(args: &Value) -> Vec<(String, String)> {
    let mut walked = args.clone();
    let mut out = Vec::new();
    let _ = crate::ask::each_site::<()>(&mut walked, &mut |site: &mut Value| {
        if let Some(f) = site.get("file").filter(|f| !f.is_null()) {
            let s = |k: &str| f.get(k).and_then(Value::as_str).unwrap_or("").to_string();
            out.push((s("root"), s("path")));
        }
        Ok(())
    });
    out
}

fn mb(n: u64) -> String {
    let m = n as f64 / (1024.0 * 1024.0);
    if m >= 10.0 { format!("{m:.0} MB") } else { format!("{m:.1} MB") }
}

/// A file name that is going to be a file name on this machine: its last
/// component only, nothing Windows refuses in a name, not a device, never empty.
/// The extension survives, since it is what `drawnAs` reads the file by.
pub fn plain_name(s: &str) -> String {
    let last = s.rsplit(['/', '\\']).next().unwrap_or("");
    let kept: String = last
        .chars()
        .filter(|c| !c.is_control() && !"<>:\"|?*".contains(*c))
        .take(120)
        .collect();
    let kept = kept.trim().trim_end_matches(['.', ' ']).to_string();
    if kept.is_empty() || kept.chars().all(|c| c == '.') {
        return "attachment".into();
    }
    /* Windows reads the stem before the first dot, less trailing spaces, as a
       device — `CON .txt` included — and counts the superscript digits after
       COM and LPT as digits. Prefixed rather than refused: it is still the
       name somebody gave a file. */
    let stem = kept.split('.').next().unwrap_or("").trim_end().to_uppercase();
    let numbered = |p: &str| {
        stem.strip_prefix(p).is_some_and(|d| {
            let mut c = d.chars();
            matches!((c.next(), c.next()), (Some(x), None) if x.is_ascii_digit() || "¹²³".contains(x))
        })
    };
    let device = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$") || numbered("COM") || numbered("LPT");
    if device { format!("_{kept}") } else { kept }
}

/// The owning wall's answer to one `look`, from the parked call's arguments.
///
/// The first ask (`want` empty) gets the arguments and the files from the
/// start; every later one gets the files from where the asker says it got to.
/// Either way the answer spends at most `BUDGET`, and says of every file what
/// it is now — so one that cannot be read any more is a fault the asker draws,
/// not a part that silently never comes.
pub fn answer(id: &str, me: &str, args: &Value, want: &[Want], disk: &mut dyn Disk) -> LookMsg {
    let said = |args: Option<Value>, files: Vec<Carried>, parts: Vec<Part>, why: Option<String>| LookMsg::Looked {
        id: id.to_string(),
        args,
        files,
        parts,
        why,
    };
    let first = want.is_empty();
    let mut spent = 0usize;
    let mut out_args = None;
    if first {
        let text = serde_json::to_string(args).map(|s| s.len()).unwrap_or(usize::MAX);
        if text > ARGS_MOST {
            return said(
                None,
                vec![],
                vec![],
                Some(format!(
                    "the question is {} of text on {me}, over the {} that crosses between walls",
                    mb(text as u64),
                    mb(ARGS_MOST as u64)
                )),
            );
        }
        spent = text;
        out_args = Some(args.clone());
    }

    let found = files_in(args);
    let mut files = Vec::with_capacity(found.len());
    let mut total = 0u64;
    for (n, (root, path)) in found.iter().enumerate() {
        let name = plain_name(path);
        /* `attach_at` wrote these as a directory and a bare file name; a name
           that climbs anywhere is not one it wrote, and is not read. */
        let (size, stamp, fault) = if root.is_empty() || path.is_empty() || path.contains(['/', '\\']) || path == ".." {
            (0, None, Some(format!("{me} holds it as something that is not a file")))
        } else {
            match disk.size(root, path) {
                Err(e) => (0, None, Some(format!("it could not be read on {me}: {e}"))),
                Ok((s, t)) if s > FILE_MOST => {
                    (s, t, Some(format!("it is {}, over the {} a question's file may be", mb(s), mb(FILE_MOST))))
                }
                Ok((s, t)) if total + s > ASK_MOST => (
                    s,
                    t,
                    Some(format!("this question's files come to more than {} together, and this one is past that", mb(ASK_MOST))),
                ),
                Ok((s, t)) => {
                    total += s;
                    (s, t, None)
                }
            }
        };
        files.push(Carried { n, name, size, stamp, fault });
    }

    let wanted: Vec<Want> = if first {
        files.iter().filter(|c| c.fault.is_none()).map(|c| Want { n: c.n, from: 0 }).collect()
    } else {
        want.to_vec()
    };
    let mut parts = Vec::new();
    for w in wanted {
        let Some(c) = files.get_mut(w.n) else { continue };
        if c.fault.is_some() || w.from >= c.size {
            continue;
        }
        let room = BUDGET.saturating_sub(spent) / 4 * 3;
        if room == 0 {
            break;
        }
        let most = ((c.size - w.from) as usize).min(room);
        let (root, path) = &found[w.n];
        match disk.read(root, path, w.from, most) {
            Ok(bytes) if !bytes.is_empty() => {
                let data = crate::base64(&bytes);
                spent += data.len();
                parts.push(Part { n: w.n, from: w.from, data });
            }
            Ok(_) => c.fault = Some(format!("it came up short on {me} — it may have changed while it was read")),
            Err(e) => c.fault = Some(format!("it could not be read on {me}: {e}")),
        }
    }
    said(out_args, files, parts, None)
}

/// What the asking wall has of one question so far.
#[derive(Debug, Default)]
pub struct Gathering {
    args: Option<Value>,
    files: Vec<Carried>,
    got: Vec<Vec<u8>>,
    /// A file stopped for a reason a second pull could get past — the link
    /// dropped, or the file moved while it crossed — rather than one the
    /// owning wall gave (too large, unreadable). See `whole`.
    retry: bool,
}

impl Gathering {
    /// Fold one answer in. `Ok(true)` when it brought bytes, `Ok(false)` when it
    /// brought none — which twice running is a wall that has stopped sending.
    /// `Err` is a question that cannot be drawn from here at all, in the words
    /// the question will carry instead.
    pub fn take(&mut self, m: LookMsg, host: &str) -> Result<bool, String> {
        let LookMsg::Looked { args, files, parts, why, .. } = m else {
            return Err(format!("{host} answered with a question of its own"));
        };
        if let Some(why) = why {
            let why: String = crate::clean::scrub(why.trim()).chars().take(400).collect();
            return Err(if why.is_empty() { format!("{host} could not send what this question shows") } else { why });
        }
        if self.args.is_none() {
            let Some(mut args) = args.filter(Value::is_object) else {
                return Err(format!("{host} sent something that is not a question"));
            };
            if serde_json::to_string(&args).map(|s| s.len()).unwrap_or(usize::MAX) > ARGS_MOST {
                return Err(format!("{host} sent a question larger than {} of text", mb(ARGS_MOST as u64)));
            }
            crate::ask::scrub_json(&mut args);
            self.args = Some(args);
            let mut total = 0u64;
            for (i, c) in files.into_iter().take(crate::ask::MAX_FILES).enumerate() {
                if c.n != i {
                    break;
                }
                let mut fault = c.fault.map(|f| crate::clean::scrub(&f).chars().take(400).collect::<String>());
                if fault.is_none() && (c.size > FILE_MOST || total + c.size > ASK_MOST) {
                    fault = Some(format!("it is {}, more than a question's file may be", mb(c.size)));
                }
                if fault.is_none() {
                    total += c.size;
                }
                self.files.push(Carried { n: i, name: plain_name(&c.name), size: c.size, stamp: c.stamp, fault });
                self.got.push(Vec::new());
            }
        } else {
            for c in files {
                let Some(mine) = self.files.get_mut(c.n) else { continue };
                let done = self.got[c.n].len() as u64 == mine.size;
                if mine.fault.is_some() || done {
                    continue;
                }
                if let Some(f) = c.fault {
                    mine.fault = Some(crate::clean::scrub(&f).chars().take(400).collect());
                } else if c.size != mine.size || c.stamp != mine.stamp {
                    mine.fault = Some(format!("it changed on {host} while it was being carried"));
                    self.retry = true;
                }
            }
        }
        let mut moved = false;
        for p in parts {
            let Some(c) = self.files.get_mut(p.n) else { continue };
            let have = &mut self.got[p.n];
            if c.fault.is_some() || p.from != have.len() as u64 {
                continue;
            }
            match crate::unbase64(&p.data) {
                None => c.fault = Some(format!("{host} sent bytes for it that do not decode")),
                Some(b) if have.len() as u64 + b.len() as u64 > c.size => {
                    c.fault = Some(format!("{host} sent more of it than it said there was"))
                }
                Some(b) if b.is_empty() => {}
                Some(b) => {
                    have.extend_from_slice(&b);
                    moved = true;
                }
            }
        }
        Ok(moved)
    }

    /// Where every file still arriving has got to — empty when there is
    /// nothing left to ask for.
    pub fn wants(&self) -> Vec<Want> {
        self.files
            .iter()
            .filter(|c| c.fault.is_none() && (self.got[c.n].len() as u64) < c.size)
            .map(|c| Want { n: c.n, from: self.got[c.n].len() as u64 })
            .collect()
    }

    /// Stop: every file still arriving is a fault saying why — one a later pull
    /// may get past, so the gathering is no longer `whole`.
    pub fn give_up(&mut self, why: &str) {
        for w in self.wants() {
            self.files[w.n].fault = Some(why.to_string());
            self.retry = true;
        }
    }

    /// Whether everything that could arrive did. False when a file stopped for
    /// a reason that is not the file's own — the front end draws what came and
    /// pulls again on the wall's next word, where a whole gathering is final.
    pub fn whole(&self) -> bool {
        !self.retry
    }

    /// The arguments, with every file slot pointed at what `write` kept here —
    /// or at a fault naming the file and the wall. `write(n, name, bytes)`
    /// returns the `(root, path)` pair it wrote. `None` if no answer ever
    /// brought the arguments.
    pub fn settle(self, host: &str, write: &mut dyn FnMut(usize, &str, &[u8]) -> Result<(String, String), String>) -> Option<Value> {
        let Gathering { args, files, got, .. } = self;
        let mut args = args?;
        let mut k = 0usize;
        let _ = crate::ask::each_site::<()>(&mut args, &mut |site: &mut Value| {
            let Some(slot) = site.get_mut("file").filter(|f| !f.is_null()) else { return Ok(()) };
            let n = k;
            k += 1;
            *slot = match files.get(n) {
                Some(c) if c.fault.is_none() && got[n].len() as u64 == c.size => match write(n, &c.name, &got[n]) {
                    Ok((root, path)) => json!({ "root": root, "path": path }),
                    Err(e) => json!({ "path": c.name, "fault": format!("{} arrived from {host} but could not be kept here: {e}", c.name) }),
                },
                Some(c) => json!({
                    "path": c.name,
                    "fault": format!(
                        "{} was not carried from {host} — {}",
                        c.name,
                        c.fault.as_deref().unwrap_or("it did not finish arriving")
                    ),
                }),
                None => json!({ "path": "attachment", "fault": format!("an attachment was not carried from {host}") }),
            };
            Ok(())
        });
        Some(args)
    }
}

/// Read the answer to request `id` out of everything an exchange brought back.
pub fn answer_in(frames: impl IntoIterator<Item = LookMsg>, id: &str) -> Option<LookMsg> {
    frames.into_iter().find(|m| matches!(m, LookMsg::Looked { id: i, .. } if i == id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    struct Map(HashMap<String, Vec<u8>>);
    impl Disk for Map {
        fn size(&mut self, root: &str, name: &str) -> Result<(u64, Option<u64>), String> {
            self.0.get(&format!("{root}/{name}")).map(|b| (b.len() as u64, Some(7))).ok_or("not found".into())
        }
        fn read(&mut self, root: &str, name: &str, from: u64, most: usize) -> Result<Vec<u8>, String> {
            let b = self.0.get(&format!("{root}/{name}")).ok_or("not found")?;
            let from = from as usize;
            Ok(b[from.min(b.len())..(from + most).min(b.len())].to_vec())
        }
    }

    fn args() -> Value {
        json!({
            "file": { "root": "C:/top", "path": "top.png" },
            "questions": [
                { "question": "which?", "preview": { "html": "<b>x</b>" },
                  "options": [
                    { "label": "a", "file": { "root": "C:/opt", "path": "a.png" } },
                    { "label": "b" },
                  ] },
                { "question": "ok?", "file": { "root": "C:/q", "path": "q.pdf" } },
            ]
        })
    }

    fn disk() -> Map {
        Map(HashMap::from([
            ("C:/top/top.png".to_string(), vec![1u8; 10]),
            ("C:/opt/a.png".to_string(), (0..=255u8).cycle().take(BUDGET * 2).collect()),
            ("C:/q/q.pdf".to_string(), b"%PDF".to_vec()),
        ]))
    }

    /// Run the whole exchange the way `link.rs` does, and keep what was written.
    fn carry(args: &Value, disk: &mut Map) -> (Value, HashMap<usize, Vec<u8>>, usize) {
        let mut g = Gathering::default();
        let mut want = vec![];
        let mut rounds = 0;
        loop {
            rounds += 1;
            let m = answer("r", "lap", args, &want, disk);
            let moved = g.take(m, "lap").unwrap();
            want = g.wants();
            if want.is_empty() || !moved || rounds > ROUNDS_MOST {
                break;
            }
        }
        let mut kept = HashMap::new();
        let out = g
            .settle("lap", &mut |n, name, bytes| {
                kept.insert(n, bytes.to_vec());
                Ok((format!("D:/afar/{n}"), name.to_string()))
            })
            .unwrap();
        (out, kept, rounds)
    }

    /// The walk is the numbering both walls agree on: the call, its options,
    /// each question and each of its options — and an option with no file
    /// takes no number.
    #[test]
    fn files_are_numbered_in_site_order() {
        let found = files_in(&args());
        assert_eq!(
            found,
            vec![
                ("C:/top".into(), "top.png".into()),
                ("C:/opt".into(), "a.png".into()),
                ("C:/q".into(), "q.pdf".into())
            ]
        );
    }

    /// Every file arrives whole, a file larger than one answer arrives over
    /// several, the preview rides along untouched, and every slot ends up
    /// pointing here.
    #[test]
    fn a_question_crosses_whole_in_parts() {
        let a = args();
        let mut d = disk();
        let (out, kept, rounds) = carry(&a, &mut d);
        assert!(rounds >= 2, "a file twice the budget took {rounds} round(s)");
        assert_eq!(kept[&0], vec![1u8; 10]);
        assert_eq!(kept[&1], d.0["C:/opt/a.png"]);
        assert_eq!(kept[&2], b"%PDF");
        assert_eq!(out["file"], json!({ "root": "D:/afar/0", "path": "top.png" }));
        assert_eq!(out["questions"][0]["options"][0]["file"], json!({ "root": "D:/afar/1", "path": "a.png" }));
        assert_eq!(out["questions"][1]["file"], json!({ "root": "D:/afar/2", "path": "q.pdf" }));
        assert_eq!(out["questions"][0]["preview"]["html"], "<b>x</b>");
        assert!(out["questions"][0]["options"][1].get("file").is_none());
    }

    /// No answer is larger than a frame can carry, however large the file.
    #[test]
    fn no_answer_spends_past_its_budget() {
        let a = args();
        let mut d = disk();
        let m = answer("r", "lap", &a, &[], &mut d);
        let text = serde_json::to_string(&m).unwrap();
        assert!(text.len() < BUDGET + 64 * 1024, "{} bytes", text.len());
        assert!(text.len() < 8 * 1024 * 1024);
    }

    /// The failures that are about one file are drawn where that file would
    /// have been, naming it and the wall, and the rest of the question still
    /// crosses.
    #[test]
    fn a_file_that_cannot_cross_is_a_fault_in_its_own_slot() {
        let a = args();
        let mut d = disk();
        d.0.remove("C:/q/q.pdf");
        d.0.insert("C:/top/top.png".into(), vec![0; (FILE_MOST + 1) as usize]);
        let (out, kept, _) = carry(&a, &mut d);
        assert!(!kept.contains_key(&0) && !kept.contains_key(&2));
        assert_eq!(kept[&1].len(), BUDGET * 2);
        let top = out["file"]["fault"].as_str().unwrap();
        assert!(top.contains("top.png") && top.contains("lap") && top.contains("24 MB"), "{top}");
        assert!(out["file"].get("root").is_none(), "a fault never keeps a root");
        let q = out["questions"][1]["file"]["fault"].as_str().unwrap();
        assert!(q.contains("q.pdf") && q.contains("could not be read on lap"), "{q}");
    }

    /// A slot is never left as the other machine wrote it: a root from there
    /// is a path on this disk, and the viewer would read it.
    #[test]
    fn a_root_from_the_other_wall_never_survives() {
        let mut g = Gathering::default();
        let forged = LookMsg::Looked {
            id: "r".into(),
            args: Some(json!({ "question": "x", "file": { "root": "C:/Users/me", "path": ".env" },
                               "options": [{ "label": "y", "file": "C:/secret.txt" }] })),
            files: vec![],
            parts: vec![],
            why: None,
        };
        g.take(forged, "lap").unwrap();
        let out = g.settle("lap", &mut |_, _, _| panic!("nothing was carried")).unwrap();
        for slot in [&out["file"], &out["options"][0]["file"]] {
            assert!(slot.get("root").is_none(), "{slot}");
            assert!(slot["fault"].as_str().unwrap().contains("not carried from lap"));
        }
    }

    /// What a peer says is held to what it said before: more bytes than the
    /// size, bytes that do not decode, a file whose size moved, and a part for a
    /// place the asker is not at.
    #[test]
    fn a_peer_cannot_send_more_than_it_declared() {
        let mut g = Gathering::default();
        let files = vec![
            Carried { n: 0, name: "a.png".into(), size: 3, stamp: None, fault: None },
            Carried { n: 1, name: "b.png".into(), size: 3, stamp: None, fault: None },
            Carried { n: 2, name: "c.png".into(), size: 3, stamp: None, fault: None },
        ];
        let first = LookMsg::Looked {
            id: "r".into(),
            args: Some(json!({ "question": "x" })),
            files: files.clone(),
            parts: vec![
                Part { n: 0, from: 0, data: crate::base64(b"abcd") },
                Part { n: 1, from: 0, data: "!!".into() },
                Part { n: 2, from: 1, data: crate::base64(b"z") },
            ],
            why: None,
        };
        assert!(!g.take(first, "lap").unwrap());
        assert!(g.files[0].fault.as_deref().unwrap().contains("more of it"));
        assert!(g.files[1].fault.as_deref().unwrap().contains("do not decode"));
        assert!(g.files[2].fault.is_none() && g.got[2].is_empty(), "a part out of place is ignored");
        let moved = LookMsg::Looked {
            id: "r".into(),
            args: None,
            /* Same size, rewritten: only the stamp says so. */
            files: vec![Carried { stamp: Some(8), ..files[2].clone() }],
            parts: vec![],
            why: None,
        };
        g.take(moved, "lap").unwrap();
        assert!(g.files[2].fault.as_deref().unwrap().contains("changed on lap"));
        assert!(g.wants().is_empty());
        assert!(!g.whole(), "a file that moved is worth pulling again");
    }

    /// A file the owning wall refused is final; one that stopped arriving is
    /// not, and says so, so the front end pulls again rather than drawing the
    /// fault for good (found in review).
    #[test]
    fn only_a_stop_that_is_not_the_files_own_is_worth_a_second_pull() {
        let mut d = disk();
        d.0.insert("C:/top/top.png".into(), vec![0; (FILE_MOST + 1) as usize]);
        let mut g = Gathering::default();
        g.take(answer("r", "lap", &args(), &[], &mut d), "lap").unwrap();
        assert!(g.whole(), "too large is the file's own answer");
        g.give_up("lap stopped answering");
        assert!(!g.whole());
        assert!(g.wants().is_empty());
    }

    /// A question that is gone or not one that travels is the whole answer,
    /// in the far wall's words.
    #[test]
    fn a_reason_is_the_whole_answer() {
        let mut g = Gathering::default();
        let m = LookMsg::Looked { id: "r".into(), args: None, files: vec![], parts: vec![], why: Some("that question is no longer waiting\u{7}".into()) };
        assert_eq!(g.take(m, "lap"), Err("that question is no longer waiting".into()));
        let m = LookMsg::Looked { id: "r".into(), args: Some(json!("no")), files: vec![], parts: vec![], why: None };
        assert!(Gathering::default().take(m, "lap").unwrap_err().contains("not a question"));
    }

    /// A name from another machine is a name here: no directory, no device,
    /// the extension kept.
    #[test]
    fn a_name_from_elsewhere_is_only_a_name() {
        assert_eq!(plain_name("shot-after.png"), "shot-after.png");
        assert_eq!(plain_name("..\\..\\Windows\\win.ini"), "win.ini");
        assert_eq!(plain_name("a/b/c:d?.png"), "cd.png");
        assert_eq!(plain_name(".."), "attachment");
        assert_eq!(plain_name(""), "attachment");
        assert_eq!(plain_name("CON.txt"), "_CON.txt");
        assert_eq!(plain_name("com1"), "_com1");
        assert_eq!(plain_name("trailing. "), "trailing");
        assert_eq!(plain_name("CON .txt"), "_CON .txt");
        assert_eq!(plain_name("COM¹.log"), "_COM¹.log");
        assert_eq!(plain_name("conout$"), "_conout$");
        assert_eq!(plain_name("COM10.txt"), "COM10.txt");
    }

    /// The two words survive the wire, and an answer from a build that added
    /// a field still reads.
    #[test]
    fn the_words_round_trip() {
        for m in [
            LookMsg::Look { id: "r".into(), card: "c".into(), ask: "a".into(), want: vec![Want { n: 1, from: 9 }] },
            LookMsg::Looked { id: "r".into(), args: Some(json!({})), files: vec![], parts: vec![], why: None },
        ] {
            let back: LookMsg = serde_json::from_value(serde_json::to_value(&m).unwrap()).unwrap();
            assert_eq!(back, m);
        }
        let newer: LookMsg = serde_json::from_value(json!({ "msg": "looked", "id": "r", "later": true })).unwrap();
        assert!(matches!(newer, LookMsg::Looked { args: None, .. }));
    }
}
