//! Reading a background job's output file while it is still being written.
//!
//! A card that backgrounds a `pnpm dev`, a watcher or a long test run gets a
//! receipt naming a file, and then nothing more until the job finishes. The
//! file is the only account of what the work is *doing*, and until now nothing
//! in Volery ever opened it — the path was carried through `startedJob`, stored
//! on the `job` row and handed to a roused card in a prompt, and that was all.
//! Sink 80e0a4ad is a person asking to read it: "I can't find a way to check
//! the logs of subprocesses of a card — a dev server, a long-running task."
//!
//! This is the whole of the Rust half, and it is one command. Three decisions
//! in it, and the first is the one that makes the feature affordable at all.
//!
//! **The file is read from where the last read stopped.** A dev server left up
//! overnight is tens of megabytes and the pane wants the last screenful of it,
//! once a second. Re-reading the file each tick would be a megabyte-per-second
//! of copying for a few hundred bytes of news — so the caller keeps the offset
//! it was last given and hands it back, and this seeks there. The first read is
//! `UNREAD`, and seeks *backwards* from the end instead: a log is opened at its
//! end, because the useful part of a running process's output is the part it
//! just printed.
//!
//! **The seek is decided here rather than in the front end**, which is the one
//! division worth stating because the fold on the other side is TypeScript and
//! tested there. Choosing an offset needs the file's length, and that is a
//! `stat` — asking for it across the IPC boundary would be a second round trip
//! per tick, for a number this function is about to have anyway. So Rust
//! decides *where in the file* and `jobs.ts` decides *what the pane holds*, and
//! the contract between them is `at`: the offset actually read from, which the
//! fold compares against the one it expected and treats a mismatch as a break
//! in continuity. Neither side has to trust the other's arithmetic.
//!
//! **Bytes, never characters.** The file is whatever the child wrote down its
//! pipe, and a read that starts at an arbitrary offset lands in the middle of a
//! UTF-8 sequence roughly one time in a hundred for non-ASCII output. Cutting
//! there and calling `String::from_utf8` fails the whole read; calling
//! `from_utf8_lossy` puts a replacement glyph in the middle of a word. So the
//! ends of the window are trimmed back to character boundaries before the
//! decode, and what that costs — at most three bytes at each end — is a
//! fragment of one line that was going to be dropped as a partial anyway.
//!
//! Nothing here knows what a job is. It takes a path and gives back bytes,
//! which is why it is not in `store.rs`: the path's *provenance* is the store's
//! business (`pending_jobs` derives and existence-checks it) and reading a file
//! is not.

use serde::Serialize;

/// The caller has read nothing yet, and wants the end of the file.
///
/// Not 0, which is a real offset — and the one a file that was truncated and
/// rewritten legitimately takes. `jobs.ts` has the same constant and the same
/// note; they are two halves of one wire format.
pub const UNREAD: i64 = -1;

/// The most one call will carry back, in bytes.
///
/// A cap on the *transport*, not on the file. When more than this has arrived
/// since the last read the newest window is taken and the caller is told, by
/// the gap between the `at` it asked for and the `at` it got, that it stepped
/// over something — which `fold` reports rather than swallowing. Kept in step
/// with `READ_BYTES` in `jobs.ts`, which is what the caller passes.
pub const MAX_READ: i64 = 4 * 1024 * 1024;

/// What one read brought back.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Chunk {
    /// The offset this actually started at, which is not necessarily the one
    /// asked for. The whole of the caller's continuity check.
    pub at: i64,
    /// Where the next read should start.
    pub next: i64,
    /// The file's length at the moment it was read, so a face can say how big
    /// the thing it is tailing has got without a second call.
    pub size: i64,
    pub text: String,
}

/// Where to read from, given how long the file is and where the caller stopped.
///
/// Pure, and separated from the reading so `cargo test` can put every case
/// through it without a file on disk. Four answers:
///
/// - **nothing read yet** (`from == UNREAD`) — the end of the file, capped.
/// - **the file is shorter than where we stopped** — it was truncated or
///   replaced, so whatever the caller holds is unrelated to what is there. The
///   end again, and the mismatched `at` tells them.
/// - **more arrived than one read carries** — the *newest* window, not the
///   oldest. This is a tail: falling further behind the harder the watched
///   thing works is the one failure mode a tail must not have.
/// - **ordinary** — exactly where they stopped.
fn window(size: i64, from: i64, cap: i64) -> (i64, i64) {
    let cap = cap.clamp(1, MAX_READ);
    /* Any negative is unread, not only `UNREAD` itself. The constant is named
       rather than the bare `< 0` written twice: it is half a wire format shared
       with `jobs.ts`, and a magic number here is the half that could drift. */
    let at = if from <= UNREAD || from > size {
        (size - cap).max(0)
    } else if size - from > cap {
        size - cap
    } else {
        from
    };
    (at, (size - at).clamp(0, cap))
}

/// Trim a byte window back to UTF-8 character boundaries.
///
/// Both ends, and for different reasons. The front may be mid-sequence because
/// the seek was arithmetic on a byte count; the back may be because the cap fell
/// mid-sequence, or because the process is *still writing* and the last write
/// landed between two bytes of one character. The second is not hypothetical on
/// a pipe.
///
/// Returns the trimmed slice and how many bytes came off the front, since the
/// caller has to add that to the offset it reports.
fn on_boundaries(buf: &[u8]) -> (&[u8], usize) {
    /* A UTF-8 continuation byte is 10xxxxxx; a character starts at anything
       else. Walking forward at most three bytes finds the first start. */
    let is_cont = |b: u8| b & 0b1100_0000 == 0b1000_0000;
    let mut head = 0;
    while head < buf.len() && head < 3 && is_cont(buf[head]) {
        head += 1;
    }
    let body = &buf[head..];
    /* And back off the tail until what remains decodes. At most three bytes,
       because that is the longest incomplete prefix a 4-byte sequence has. */
    let mut end = body.len();
    for _ in 0..3 {
        if std::str::from_utf8(&body[..end]).is_ok() {
            break;
        }
        end = end.saturating_sub(1);
    }
    (&body[..end], head)
}

/// Read a slice of a file, seeking as `window` decides.
///
/// The error cases are deliberately *errors* rather than an empty chunk: a path
/// that is not there is the case `store::pending_jobs` already guards against
/// by existence-checking derived paths, so reaching it here means something
/// moved between the two — and a pane that drew nothing would say "this process
/// has printed nothing", which is a different and wrong thing.
pub fn read_from(path: &std::path::Path, from: i64, cap: i64) -> Result<Chunk, String> {
    use std::io::{Seek, SeekFrom};

    let mut f = std::fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let size = f
        .metadata()
        .map_err(|e| format!("{}: {e}", path.display()))?
        .len()
        .min(i64::MAX as u64) as i64;

    let (at, take) = window(size, from, cap);
    if take == 0 {
        return Ok(Chunk { at, next: at, size, text: String::new() });
    }

    f.seek(SeekFrom::Start(at as u64)).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; take as usize];
    /* `read_exact` would be wrong: the file is being appended to by another
       process, so between the `stat` and the seek it may have grown — but it may
       also be a pipe-backed file the OS reports optimistically, and a short read
       is a normal thing rather than a failure. Take what came. */
    let got = read_up_to(&mut f, &mut buf).map_err(|e| e.to_string())?;
    buf.truncate(got);

    let (body, head) = on_boundaries(&buf);
    let at = at + head as i64;
    Ok(Chunk {
        at,
        next: at + body.len() as i64,
        size,
        /* Infallible by construction — `on_boundaries` has already proved this
           slice decodes — but not `unwrap`ed, because a panic here is a card
           whose log pane kills the command rather than showing one bad line. */
        text: String::from_utf8_lossy(body).into_owned(),
    })
}

/// Fill as much of `buf` as the file has, tolerating short reads.
fn read_up_to(f: &mut std::fs::File, buf: &mut [u8]) -> std::io::Result<usize> {
    use std::io::Read;
    let mut n = 0;
    while n < buf.len() {
        match f.read(&mut buf[n..]) {
            Ok(0) => break,
            Ok(k) => n += k,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(n)
}

/// Read the tail of a background job's output file.
///
/// **`async`, and that is not decoration.** A `#[tauri::command]` without it
/// runs inline on the thread that dispatched the IPC — the main thread, which
/// is also the only thread that drains the event loop — so a slow read would
/// not make one command slow, it would stop every card on the wall being
/// painted for as long as it took. And `#[tauri::command(async)]` is not the
/// fix either: that arm spawns onto the runtime's *worker* pool, which is the
/// same pool that delivers every command's response. `crate::off_main` is
/// `spawn_blocking`, which is the pool built for work that parks a thread. See
/// the rule in `CLAUDE.md`; a file read off a network drive is exactly the
/// shape that found it.
#[tauri::command]
pub async fn job_output(path: String, from: i64, cap: i64) -> Result<Chunk, String> {
    crate::off_main(move || read_from(std::path::Path::new(&path), from, cap)).await?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_first_read_opens_at_the_end() {
        /* The whole reason `UNREAD` is not 0. A 10 MB log opened at 0 shows the
           morning's startup banner as though it were now. */
        let (at, take) = window(10_000, UNREAD, 1_000);
        assert_eq!((at, take), (9_000, 1_000));
    }

    #[test]
    fn a_short_file_is_read_whole() {
        assert_eq!(window(400, UNREAD, 1_000), (0, 400));
        assert_eq!(window(0, UNREAD, 1_000), (0, 0));
    }

    #[test]
    fn an_ordinary_read_continues_where_it_stopped() {
        assert_eq!(window(1_500, 1_000, 1_000), (1_000, 500));
    }

    #[test]
    fn nothing_new_is_an_empty_window_rather_than_an_error() {
        let (at, take) = window(1_000, 1_000, 1_000);
        assert_eq!((at, take), (1_000, 0));
    }

    #[test]
    fn a_burst_bigger_than_the_cap_takes_the_newest() {
        /* Not (1_000, 1_000). A tail that took the oldest window would fall
           further behind the harder the watched thing worked. */
        assert_eq!(window(9_000, 1_000, 1_000), (8_000, 1_000));
    }

    #[test]
    fn a_truncated_file_is_reopened_at_its_new_end() {
        /* `from` past the end means something replaced the file. What the caller
           holds is unrelated to what is there, and the mismatched `at` is how it
           finds out. */
        assert_eq!(window(500, 9_000, 1_000), (0, 500));
    }

    #[test]
    fn the_cap_is_bounded_both_ways() {
        assert_eq!(window(10, 0, 0).1, 10.min(1));
        assert_eq!(window(i64::MAX, UNREAD, i64::MAX).1, MAX_READ);
    }

    #[test]
    fn a_window_that_starts_mid_character_is_trimmed_forward() {
        /* "é" is two bytes. Cutting between them and decoding lossily would put
           a replacement glyph at the head of the pane, once every hundred reads
           of a log with any non-ASCII in it. */
        let whole = "aéb".as_bytes();
        let (body, head) = on_boundaries(&whole[2..]);
        assert_eq!(head, 1, "one continuation byte came off the front");
        assert_eq!(std::str::from_utf8(body).unwrap(), "b");
    }

    #[test]
    fn a_window_that_ends_mid_character_is_trimmed_back() {
        /* The live case: the process wrote the first byte of a character and
           has not yet written the second. */
        let whole = "abé".as_bytes();
        let (body, head) = on_boundaries(&whole[..3]);
        assert_eq!(head, 0);
        assert_eq!(std::str::from_utf8(body).unwrap(), "ab");
    }

    #[test]
    fn ascii_is_never_trimmed() {
        let (body, head) = on_boundaries(b"hello");
        assert_eq!(head, 0);
        assert_eq!(body, b"hello");
    }

    #[test]
    fn reading_a_real_file_tails_it_and_then_follows_it() {
        let dir = std::env::temp_dir().join(format!("volery-joblog-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("a.output");
        std::fs::write(&p, b"one\ntwo\n").unwrap();

        let first = read_from(&p, UNREAD, 1_000).unwrap();
        assert_eq!(first.text, "one\ntwo\n");
        assert_eq!(first.at, 0);
        assert_eq!(first.next, 8);
        assert_eq!(first.size, 8);

        /* Nothing appended: an empty chunk at the same place, which is what a
           second tick finds nearly every time and must cost nothing. */
        let idle = read_from(&p, first.next, 1_000).unwrap();
        assert_eq!(idle.text, "");
        assert_eq!(idle.next, 8);

        std::fs::write(&p, b"one\ntwo\nthree\n").unwrap();
        let more = read_from(&p, idle.next, 1_000).unwrap();
        assert_eq!(more.at, 8, "continuous with the last read");
        assert_eq!(more.text, "three\n");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_missing_file_is_an_error_and_not_an_empty_log() {
        /* An empty chunk would draw as "this process has printed nothing",
           which is a different and wrong thing to tell somebody. */
        let p = std::env::temp_dir().join("volery-joblog-nothing-here.output");
        std::fs::remove_file(&p).ok();
        assert!(read_from(&p, UNREAD, 1_000).is_err());
    }
}
