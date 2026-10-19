//! A sluice: the one door a stream of lines goes through on its way to the wall.
//!
//! ### Why this exists — 2026-10-19, 17:04 to 17:14
//!
//! A card removed a git worktree whose `node_modules` was a junction into the
//! main tree's, and git deleted through it. The nova dev server, still running,
//! lost half its packages and printed **741,000 lines in five minutes** — every
//! one a "Module not found" stack — peaking at 32,000 in a single second (read
//! back afterwards out of `nova/.next/dev/logs/next-development.log`, which is
//! the only reason anybody knows).
//!
//! Every one of those lines was its own `app.emit`. An emit from a reader thread
//! is `proxy.send_event` — a queue onto the main thread — and the main thread
//! then evaluates it in *every* webview, where the wall's listener re-sliced a
//! 400-element `$state` array per line. The queue is unbounded and the main
//! thread is also the one that answers every `invoke`, so for ten minutes
//! nothing on the wall moved: no question was drawn, no confirmation could be
//! clicked, no prompt could be sent. The flood stopped at 17:09; the wall was
//! still digesting it at 17:14, when Lyss restarted it.
//!
//! The cost of a line to the main thread was proportional to how fast a child
//! process *chose to print*, which is not a number anybody here controls. This
//! makes it proportional to a clock instead.
//!
//! ### What it does
//!
//! A pump thread `push`es; a flusher thread of the sluice's own drains what has
//! gathered and hands it to `emit` as **one batch**, then waits `period` before
//! it may emit again. So however hard a child prints, the main thread hears
//! about it at most `1 / period` times a second — ten, for a dev server.
//!
//! Two kinds, and the difference is whether a line may be left out:
//!
//! - **Capped** (`cap: Some(n)`), for a log a person reads. Only the newest `n`
//!   lines of a batch survive, and the batch says how many it `skipped`. `n` is
//!   the reader's own scrollback, so nothing is dropped that the reader would
//!   not have evicted anyway the moment the batch landed — the difference is
//!   that it is evicted *here*, for free, instead of after a trip through the
//!   event loop and a re-render each. The full record, where one exists (a
//!   server group's 2,000-line ring), is written before the sluice and is
//!   untouched by it.
//! - **Lossless** (`cap: None`), for a stream whose every item matters — a
//!   card's events. Nothing is dropped; what is bounded is the *number of
//!   emits*, which is where the main thread's cost per item mostly was.
//!
//! ### Order, which is the subtle half
//!
//! A stream's lines are often followed by an event *about* the stream — the
//! shell's prompt marker after a command's output, `exited` after a server's
//! last words, `conv:exit` after a card's last event. Those used to be ordered
//! for free because everything was emitted inline. Now the lines are pending in
//! here, so whoever is about to say something after them calls `flush` first,
//! which emits what is pending **on the caller's thread, under the same lock
//! the flusher emits under** — so the flusher can never interleave an older
//! batch after it. Emits land on the event loop in the order they were made,
//! and that order is the order of the stream.
//!
//! ### Heat
//!
//! A sluice may also be told what a flood is (`Flood`): a rate held for a
//! while. It then reports its `Heat` to a callback on its own thread — once
//! when a flood starts, once a second while it lasts, and once when it ends —
//! which is how a server group that has lost the plot gets marked and, a minute
//! later, stopped (`servers.rs`). The callback is called *outside* the lock, so
//! it may push, flush, or take a server down without deadlocking against the
//! thread that is pumping into it.
//!
//! Std only, on purpose: no `AppHandle`, no serde. The emit is a closure, so the
//! whole of this is reachable by `tools/lift-sluice.ts` on a machine where
//! `cargo test` cannot link.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

/// What a flood is, for a sluice asked to notice one.
#[derive(Debug, Clone, Copy)]
pub struct Flood {
    /// Items a second, held over a whole second, that count as hot.
    pub rate: u32,
    /// How long it must stay hot before it is called a flood. A burst — a
    /// compile that dumps its errors in one go, `pnpm install` redrawing its
    /// progress — is hot for a second or two and is not one.
    pub after: Duration,
}

/// How hot a sluice is running, as told to its heat callback.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Heat {
    pub flooding: bool,
    /// Items a second over the last whole window.
    pub rate: u32,
    /// How long it has been hot — counted from the first hot second, not from
    /// when it was called a flood, so a caller's "stop after a minute" means a
    /// minute of output rather than a minute plus `after`.
    pub hot_for: Duration,
}

/// How a sluice is set.
#[derive(Debug, Clone, Copy)]
pub struct Spec {
    /// What this stream is called in the tally (`busiest`) — the event name,
    /// by convention, since that is what a stall report wants to name.
    pub name: &'static str,
    /// The newest this many are kept per batch, the rest counted as skipped.
    /// `None` keeps everything.
    pub cap: Option<usize>,
    /// The least time between two emits from the flusher. A `flush` is not
    /// held to it — it is asked for because something must follow the lines.
    pub period: Duration,
    pub flood: Option<Flood>,
}

type Emit<T> = Box<dyn FnMut(Vec<T>, usize) + Send>;

/// The state behind the lock. Everything here but `emit` is pure bookkeeping
/// and is asserted directly below.
struct Gate<T> {
    pending: VecDeque<T>,
    skipped: usize,
    closed: bool,
    cap: Option<usize>,
    meter: Meter,
}

impl<T> Gate<T> {
    fn new(cap: Option<usize>, flood: Option<Flood>, now: Instant) -> Self {
        Gate {
            pending: VecDeque::new(),
            skipped: 0,
            closed: false,
            cap,
            meter: Meter::new(flood, now),
        }
    }

    /// Take one in. Eviction happens here rather than at the drain, so a
    /// flood can never hold more than `cap` items in memory between two ticks.
    fn take_in(&mut self, item: T) {
        self.meter.count += 1;
        self.pending.push_back(item);
        if let Some(cap) = self.cap {
            while self.pending.len() > cap {
                self.pending.pop_front();
                self.skipped += 1;
            }
        }
    }

    /// Everything pending and how many were skipped to get it, or `None` when
    /// there is nothing to say — a batch of nothing is an emit of nothing.
    fn drain(&mut self) -> Option<(Vec<T>, usize)> {
        if self.pending.is_empty() && self.skipped == 0 {
            return None;
        }
        let batch: Vec<T> = self.pending.drain(..).collect();
        let skipped = std::mem::take(&mut self.skipped);
        Some((batch, skipped))
    }
}

/// The flood reading: items counted per whole-second window.
struct Meter {
    flood: Option<Flood>,
    count: u64,
    window: Instant,
    hot_since: Option<Instant>,
    flooding: bool,
    rate: u32,
}

impl Meter {
    fn new(flood: Option<Flood>, now: Instant) -> Self {
        Meter { flood, count: 0, window: now, hot_since: None, flooding: false, rate: 0 }
    }

    /// Whether the meter has anything to watch: a flood spec and a window that
    /// is hot or has something in it. A cold, empty sluice has no reason to
    /// wake, and must not — a wall of idle groups is a wall of idle threads.
    fn warm(&self) -> bool {
        self.flood.is_some() && (self.hot_since.is_some() || self.count > 0)
    }

    /// Close any whole window that has passed and say what changed. `Some`
    /// on a transition either way, and once per window while flooding.
    fn read(&mut self, now: Instant) -> Option<Heat> {
        let flood = self.flood?;
        let span = now.saturating_duration_since(self.window);
        if span < Duration::from_secs(1) {
            return None;
        }
        let rate = (self.count as f64 / span.as_secs_f64()).round() as u32;
        self.rate = rate;
        self.count = 0;
        let started = self.window;
        self.window = now;

        if rate >= flood.rate {
            self.hot_since.get_or_insert(started);
        } else {
            self.hot_since = None;
        }
        let hot_for = self
            .hot_since
            .map(|s| now.saturating_duration_since(s))
            .unwrap_or_default();
        let was = self.flooding;
        self.flooding = self.hot_since.is_some() && hot_for >= flood.after;

        (self.flooding || was).then_some(Heat { flooding: self.flooding, rate, hot_for })
    }

    /// The stream has ended. A flood cannot outlive it — a group that floods
    /// and then dies is dead, not flooding — and the window that would have
    /// said so will never close, so it is said here.
    fn close(&mut self) -> Option<Heat> {
        let was = std::mem::take(&mut self.flooding);
        self.hot_since = None;
        was.then_some(Heat { flooding: false, rate: 0, hot_for: Duration::ZERO })
    }
}

struct Shared<T> {
    gate: Mutex<(Gate<T>, Emit<T>)>,
    wake: Condvar,
    /// Live `Sluice` handles. The flusher holds the `Arc` but is not a handle,
    /// so this reaching zero is "nobody can push any more" — the sluice closes
    /// itself, flushing what is left, and its thread ends.
    handles: AtomicUsize,
    period: Duration,
}

impl<T> Shared<T> {
    fn push(&self, item: T) {
        let mut g = self.gate.lock().unwrap_or_else(|p| p.into_inner());
        let (gate, emit) = &mut *g;
        gate.take_in(item);
        if gate.closed {
            /* Nobody is flushing any more, so this one goes now — still under
               the lock, still after everything that went before it. */
            if let Some((batch, skipped)) = gate.drain() {
                emit(batch, skipped);
            }
            return;
        }
        drop(g);
        self.wake.notify_one();
    }

    fn flush(&self) {
        let mut g = self.gate.lock().unwrap_or_else(|p| p.into_inner());
        let (gate, emit) = &mut *g;
        if let Some((batch, skipped)) = gate.drain() {
            emit(batch, skipped);
        }
    }

    fn close(&self) {
        let mut g = self.gate.lock().unwrap_or_else(|p| p.into_inner());
        let (gate, emit) = &mut *g;
        gate.closed = true;
        if let Some((batch, skipped)) = gate.drain() {
            emit(batch, skipped);
        }
        drop(g);
        self.wake.notify_one();
    }
}

/// A handle onto one sluice. Clone it into every thread that pumps; the sluice
/// closes, flushing what is left, when the last handle goes.
pub struct Sluice<T: Send + 'static> {
    shared: Arc<Shared<T>>,
}

/// What the heat callback is handed: the sluice, without being a handle on it.
///
/// A handle would keep the sluice open for as long as the flusher lives, and
/// the flusher lives until the sluice closes — so it is a tap instead, which
/// can push but does not count.
pub struct Tap<T: Send + 'static> {
    shared: Arc<Shared<T>>,
}

impl<T: Send + 'static> Tap<T> {
    pub fn push(&self, item: T) {
        self.shared.push(item);
    }
}

impl<T: Send + 'static> Clone for Tap<T> {
    fn clone(&self) -> Self {
        Tap { shared: self.shared.clone() }
    }
}

impl<T: Send + 'static> Sluice<T> {
    /// Open one. `emit` is called with each batch and how many items were
    /// skipped to make it; `heat`, if there is a flood spec, with each reading.
    pub fn open(
        spec: Spec,
        emit: impl FnMut(Vec<T>, usize) + Send + 'static,
        mut heat: impl FnMut(Heat, &Tap<T>) + Send + 'static,
    ) -> Self {
        let name = spec.name;
        let mut emit = emit;
        let counted = move |batch: Vec<T>, skipped: usize| {
            count(name, batch.len() + skipped);
            emit(batch, skipped);
        };
        let shared = Arc::new(Shared {
            gate: Mutex::new((Gate::new(spec.cap, spec.flood, Instant::now()), Box::new(counted) as Emit<T>)),
            wake: Condvar::new(),
            handles: AtomicUsize::new(1),
            period: spec.period,
        });
        let tap = Tap { shared: shared.clone() };
        let spawned = std::thread::Builder::new()
            .name("sluice".into())
            .spawn(move || flusher(&tap, &mut heat));
        if spawned.is_err() {
            /* No thread, no batching: the sluice degrades to emitting each
               item as it arrives, which is what everything did before it
               existed. Worse under a flood, never silent. */
            shared.gate.lock().unwrap_or_else(|p| p.into_inner()).0.closed = true;
        }
        Sluice { shared }
    }

    pub fn push(&self, item: T) {
        self.shared.push(item);
    }

    /// Emit what is pending, now, on this thread — call it before saying
    /// anything that must come after the lines already pushed.
    pub fn flush(&self) {
        self.shared.flush();
    }
}

impl<T: Send + 'static> Clone for Sluice<T> {
    fn clone(&self) -> Self {
        self.shared.handles.fetch_add(1, Ordering::SeqCst);
        Sluice { shared: self.shared.clone() }
    }
}

impl<T: Send + 'static> Drop for Sluice<T> {
    fn drop(&mut self) {
        if self.shared.handles.fetch_sub(1, Ordering::SeqCst) == 1 {
            self.shared.close();
        }
    }
}

/// Emits and items per stream name since the tally was last read.
///
/// Every sluice in the process adds to it, so it is the one place that can say
/// *which* stream was pouring when the main thread stopped answering — which is
/// the question `watchdog.rs` is asked, and which nobody could answer the night
/// this module was written for.
static TALLY: Mutex<Vec<(&'static str, u64, u64)>> = Mutex::new(Vec::new());

fn count(name: &'static str, items: usize) {
    let mut t = TALLY.lock().unwrap_or_else(|p| p.into_inner());
    match t.iter_mut().find(|(n, _, _)| *n == name) {
        Some((_, emits, total)) => {
            *emits += 1;
            *total += items as u64;
        }
        None => t.push((name, 1, items as u64)),
    }
}

/// The busiest streams since the last read, most items first, and start
/// counting again: `(name, emits, items)`.
pub fn busiest() -> Vec<(&'static str, u64, u64)> {
    let mut t = std::mem::take(&mut *TALLY.lock().unwrap_or_else(|p| p.into_inner()));
    t.sort_by(|a, b| b.2.cmp(&a.2));
    t
}

fn flusher<T: Send + 'static>(tap: &Tap<T>, heat: &mut dyn FnMut(Heat, &Tap<T>)) {
    let shared = &tap.shared;
    loop {
        let mut g = shared.gate.lock().unwrap_or_else(|p| p.into_inner());
        /* Sleep until there is something to do. A cold sluice waits on the
           condvar alone; a warm one wakes once a second as well, because a
           flood *ending* is silence, and silence pushes nothing. */
        while g.0.pending.is_empty() && g.0.skipped == 0 && !g.0.closed {
            if g.0.meter.warm() {
                let (back, _) = shared
                    .wake
                    .wait_timeout(g, Duration::from_secs(1))
                    .unwrap_or_else(|p| p.into_inner());
                g = back;
                break;
            }
            g = shared.wake.wait(g).unwrap_or_else(|p| p.into_inner());
        }
        let (gate, emit) = &mut *g;
        if let Some((batch, skipped)) = gate.drain() {
            emit(batch, skipped);
        }
        let closed = gate.closed;
        let reading = if closed { gate.meter.close() } else { gate.meter.read(Instant::now()) };
        drop(g);

        if let Some(h) = reading {
            heat(h, tap);
        }
        if closed {
            return;
        }
        std::thread::sleep(shared.period);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    #[test]
    fn a_capped_gate_keeps_the_newest_and_counts_the_rest() {
        let mut g: Gate<u32> = Gate::new(Some(3), None, Instant::now());
        for i in 0..10 {
            g.take_in(i);
        }
        assert_eq!(g.drain(), Some((vec![7, 8, 9], 7)));
        assert_eq!(g.drain(), None, "a drained gate has nothing to say");
    }

    #[test]
    fn a_lossless_gate_keeps_everything_in_order() {
        let mut g: Gate<u32> = Gate::new(None, None, Instant::now());
        for i in 0..5000 {
            g.take_in(i);
        }
        let (batch, skipped) = g.drain().unwrap();
        assert_eq!(skipped, 0);
        assert_eq!(batch, (0..5000).collect::<Vec<_>>());
    }

    const FLOOD: Flood = Flood { rate: 1000, after: Duration::from_secs(5) };

    /// Drive a meter through whole seconds at a given rate.
    fn second(m: &mut Meter, t: &mut Instant, items: u64) -> Option<Heat> {
        m.count += items;
        *t += Duration::from_secs(1);
        m.read(*t)
    }

    #[test]
    fn a_burst_is_not_a_flood() {
        let mut t = Instant::now();
        let mut m = Meter::new(Some(FLOOD), t);
        for _ in 0..4 {
            assert_eq!(second(&mut m, &mut t, 5000), None, "hot, but not for long enough");
        }
        assert_eq!(second(&mut m, &mut t, 10), None, "and cooling resets it");
        for _ in 0..4 {
            assert_eq!(second(&mut m, &mut t, 5000), None);
        }
    }

    #[test]
    fn a_held_rate_becomes_a_flood_and_says_when_it_ends() {
        let mut t = Instant::now();
        let mut m = Meter::new(Some(FLOOD), t);
        for _ in 0..4 {
            assert_eq!(second(&mut m, &mut t, 2000), None);
        }
        let on = second(&mut m, &mut t, 2000).expect("five hot seconds is a flood");
        assert!(on.flooding);
        assert_eq!(on.rate, 2000);
        assert_eq!(on.hot_for, Duration::from_secs(5));

        let still = second(&mut m, &mut t, 2000).expect("said again while it lasts");
        assert!(still.flooding);
        assert_eq!(still.hot_for, Duration::from_secs(6));

        let off = second(&mut m, &mut t, 3).expect("and once when it stops");
        assert!(!off.flooding);
        assert_eq!(off.hot_for, Duration::ZERO);
        assert_eq!(second(&mut m, &mut t, 3), None, "then nothing");
    }

    #[test]
    fn a_flood_ends_when_its_stream_does() {
        let mut t = Instant::now();
        let mut m = Meter::new(Some(FLOOD), t);
        for _ in 0..6 {
            second(&mut m, &mut t, 2000);
        }
        assert!(m.flooding);
        let off = m.close().expect("a flood that was on is said to be off");
        assert!(!off.flooding);
        assert_eq!(m.close(), None, "and only once");
        let mut cold = Meter::new(Some(FLOOD), t);
        assert_eq!(cold.close(), None, "a stream that never flooded says nothing");
    }

    #[test]
    fn a_closing_sluice_reports_its_flood_over() {
        let (tx, rx) = mpsc::channel::<Heat>();
        let s: Sluice<u32> = Sluice::open(
            Spec { name: "test", cap: Some(1), period: ms(10), flood: Some(Flood { rate: 1, after: Duration::ZERO }) },
            |_, _| {},
            move |h, _| { let _ = tx.send(h); },
        );
        let end = Instant::now() + Duration::from_millis(1500);
        while Instant::now() < end {
            s.push(1);
            std::thread::sleep(ms(5));
        }
        drop(s);
        let all: Vec<Heat> = std::iter::from_fn(|| rx.recv_timeout(Duration::from_secs(2)).ok()).collect();
        assert!(all.iter().any(|h| h.flooding), "it was called a flood: {all:?}");
        assert!(!all.last().unwrap().flooding, "and the last word is that it is over: {all:?}");
    }

    #[test]
    fn a_meter_with_no_flood_spec_never_reads_and_never_warms() {
        let mut t = Instant::now();
        let mut m = Meter::new(None, t);
        assert_eq!(second(&mut m, &mut t, 1_000_000), None);
        assert!(!m.warm());
    }

    #[test]
    fn a_partial_window_is_not_read() {
        let t = Instant::now();
        let mut m = Meter::new(Some(FLOOD), t);
        m.count = 99_999;
        assert_eq!(m.read(t + ms(999)), None);
        assert_eq!(m.count, 99_999, "the window is still open");
    }

    fn collecting(spec: Spec) -> (Sluice<u32>, mpsc::Receiver<(Vec<u32>, usize)>) {
        let (tx, rx) = mpsc::channel();
        let s = Sluice::open(spec, move |b, k| { let _ = tx.send((b, k)); }, |_, _| {});
        (s, rx)
    }

    #[test]
    fn a_flood_of_pushes_becomes_a_handful_of_emits_and_loses_nothing_lossless() {
        let (s, rx) = collecting(Spec { name: "test", cap: None, period: ms(50), flood: None });
        let start = Instant::now();
        for i in 0..200_000u32 {
            s.push(i);
        }
        drop(s);
        let mut seen = Vec::new();
        let mut emits = 0;
        while let Ok((batch, skipped)) = rx.recv_timeout(Duration::from_secs(5)) {
            assert_eq!(skipped, 0);
            seen.extend(batch);
            emits += 1;
        }
        assert_eq!(seen, (0..200_000).collect::<Vec<_>>(), "every item, in order");
        /* One emit per period while pushing, plus the close. The push loop
           takes milliseconds, so this is a few — and never 200,000. */
        let bound = (start.elapsed().as_millis() / 50 + 3) as usize;
        assert!(emits <= bound, "{emits} emits for {:?}", start.elapsed());
    }

    #[test]
    fn a_capped_sluice_hands_over_the_tail_and_the_count() {
        let (s, rx) = collecting(Spec { name: "test", cap: Some(400), period: ms(50), flood: None });
        for i in 0..100_000u32 {
            s.push(i);
        }
        drop(s);
        let mut last = None;
        let mut total = 0usize;
        while let Ok((batch, skipped)) = rx.recv_timeout(Duration::from_secs(5)) {
            assert!(batch.len() <= 400);
            total += batch.len() + skipped;
            last = batch.last().copied().or(last);
        }
        assert_eq!(total, 100_000, "every item is either handed over or counted");
        assert_eq!(last, Some(99_999), "and the newest always survives");
    }

    #[test]
    fn flush_puts_the_pending_lines_ahead_of_whatever_follows() {
        let (tx, rx) = mpsc::channel::<String>();
        let tx2 = tx.clone();
        let s = Sluice::open(
            /* A period so long the flusher could never have got there first. */
            Spec { name: "test", cap: None, period: Duration::from_secs(60), flood: None },
            move |b: Vec<u32>, _| {
                for i in b {
                    let _ = tx.send(i.to_string());
                }
            },
            |_, _| {},
        );
        /* Give the flusher its first (empty) look and send it to sleep. */
        std::thread::sleep(ms(20));
        s.push(1);
        s.push(2);
        s.flush();
        let _ = tx2.send("done".into());
        let got: Vec<String> = rx.try_iter().collect();
        assert_eq!(got, ["1", "2", "done"]);
    }

    #[test]
    fn a_push_after_close_still_arrives() {
        let (tx, rx) = mpsc::channel();
        let s = Sluice::open(
            Spec { name: "test", cap: None, period: ms(10), flood: None },
            move |b: Vec<u32>, _| { let _ = tx.send(b); },
            |_, _| {},
        );
        let tap = Tap { shared: s.shared.clone() };
        drop(s);
        tap.push(7);
        let all: Vec<u32> = rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(all, [7]);
    }

    #[test]
    fn the_tally_counts_what_each_stream_emitted() {
        let (s, rx) = collecting(Spec { name: "tally-test", cap: Some(10), period: ms(10), flood: None });
        for i in 0..100u32 {
            s.push(i);
        }
        drop(s);
        while rx.recv_timeout(Duration::from_secs(1)).is_ok() {}
        let ours = busiest().into_iter().find(|(n, _, _)| *n == "tally-test");
        let (_, emits, items) = ours.expect("the stream is in the tally");
        assert!(emits >= 1);
        assert_eq!(items, 100, "items handed over and items skipped, together");
    }

    #[test]
    fn the_flusher_ends_when_the_last_handle_goes() {
        let (s, _rx) = collecting(Spec { name: "test", cap: None, period: ms(10), flood: None });
        let weak = Arc::downgrade(&s.shared);
        let other = s.clone();
        drop(s);
        std::thread::sleep(ms(50));
        assert!(weak.upgrade().is_some(), "one handle is still out");
        drop(other);
        let deadline = Instant::now() + Duration::from_secs(2);
        while weak.upgrade().is_some() && Instant::now() < deadline {
            std::thread::sleep(ms(10));
        }
        assert!(weak.upgrade().is_none(), "the thread let go of it");
    }
}
