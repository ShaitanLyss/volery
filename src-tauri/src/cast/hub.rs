//! The hub: one capture per monitor however many viewers, at most two
//! encodes of it, and every encoded frame fanned out to its viewers as the
//! same bytes.
//!
//! A monitor's capture thread starts with its first subscriber and stops with
//! its last. It owns everything GPU-side — the duplication, the scalers, the
//! encoders — so nothing per-frame ever crosses into another thread except the
//! finished bytes. The encoder's own event thread does the fan-out, through
//! `Viewer::send`, which must not block (`mod.rs`).
//!
//! The decisions are pure and tested: what fps a want earns (`fps_for`), what
//! size a rendition is (`rung`), how wants collapse into at most two renditions
//! (`plan`), what bitrate each gets (`kbps_for`), and the queue a slow viewer
//! drops into (`Queue`, behind `Outbox`).

use super::{wire, Out, Viewer, Want};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

/// Below this a tile is a thumbnail and gets the thumbnail's frame rate.
pub const SMALL_W: u32 = 480;
/// What a focused tile is capped at whatever the panel runs at: past 120 the
/// encoder's time per frame starts to be the latency, and nobody's decoder in
/// a webview presents faster than the wall's own compositor anyway.
pub const FOCUSED_MAX_FPS: u32 = 120;
pub const VISIBLE_FPS: u32 = 30;
pub const SMALL_FPS: u32 = 15;

/// The frame rate a want earns (the table in `docs/SCREENS.md`): nothing when
/// it cannot be seen, the panel's own rate (capped) when focused, a
/// thumbnail's rate when small, and otherwise 30 — never more than the viewer
/// says it can use.
pub fn fps_for(want: &Want, hz: u32) -> u32 {
    if !want.visible || want.w == 0 || want.h == 0 {
        return 0;
    }
    let policy = if want.focused {
        hz.clamp(1, FOCUSED_MAX_FPS)
    } else if want.w < SMALL_W {
        SMALL_FPS
    } else {
        VISIBLE_FPS
    };
    if want.fps > 0 { policy.min(want.fps) } else { policy }
}

/// Fractions of native size a rendition may be, largest first. A ladder rather
/// than the tile's exact size so that resizing a tile by a few pixels — which a
/// drag does sixty times a second — does not rebuild an encoder each time.
const LADDER: [(u32, u32); 8] = [(1, 1), (3, 4), (2, 3), (1, 2), (1, 3), (1, 4), (1, 6), (1, 8)];

/// The smallest rung that still covers what the viewer wants to draw (so a
/// tile is never sent less than it can show), as an even size that keeps the
/// source's aspect. `native` itself when the want is as big or bigger.
pub fn rung(native: (u32, u32), want: (u32, u32)) -> (u32, u32) {
    let even = |v: u32| (v & !1).max(2);
    /* The tile fits the image inside itself, so the scale it draws at is the
       smaller of its two ratios; a rung covers it when it is at least that. */
    let needed = (want.0 as f64 / native.0.max(1) as f64).min(want.1 as f64 / native.1.max(1) as f64);
    let pick = LADDER.iter().rev().find(|r| r.0 as f64 / r.1 as f64 >= needed).copied().unwrap_or(LADDER[0]);
    (even(native.0 * pick.0 / pick.1), even(native.1 * pick.0 / pick.1))
}

/// Bits for pixels: 0.08 bits per pixel per frame is a screen of text and
/// windows at a quality nobody squints at with a low-latency CBR encoder,
/// bounded below so a thumbnail is legible and above so a 1440p120 stream is
/// one a loopback socket and a decoder shrug at. A viewer's cap (the flyway
/// steering to the path) wins over all of it.
pub fn kbps_for(size: (u32, u32), fps: u32, cap: Option<u32>) -> u32 {
    let natural = (size.0 as f64 * size.1 as f64 * fps.max(1) as f64 * 0.08 / 1000.0).clamp(400.0, 40_000.0) as u32;
    match cap {
        Some(c) => natural.min(c.max(100)),
        None => natural,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rendition {
    pub size: (u32, u32),
    pub fps: u32,
    pub kbps: u32,
}

/// What the hub encodes for a set of wants, and which rendition each viewer
/// takes (`None` is paused).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Plan {
    pub renditions: Vec<Rendition>,
    pub assign: Vec<Option<usize>>,
}

/// At most two renditions: the largest anyone wants, and a thumbnail for
/// whoever wants half of that or less. Each runs at the fastest rate any of
/// its viewers earns, at the lowest bitrate cap any of them carries.
pub fn plan(native: (u32, u32), hz: u32, wants: &[(Want, Option<u32>)]) -> Plan {
    let sized: Vec<Option<((u32, u32), u32)>> = wants
        .iter()
        .map(|(w, _)| {
            let fps = fps_for(w, hz);
            (fps > 0).then(|| (rung(native, (w.w, w.h)), fps))
        })
        .collect();
    let area = |s: (u32, u32)| s.0 as u64 * s.1 as u64;
    let Some(big) = sized.iter().flatten().map(|s| s.0).max_by_key(|s| area(*s)) else {
        return Plan { renditions: Vec::new(), assign: vec![None; wants.len()] };
    };
    let thumb = sized.iter().flatten().map(|s| s.0).filter(|s| s.0 * 2 <= big.0).max_by_key(|s| area(*s));
    let mut sizes = vec![big];
    sizes.extend(thumb);
    let assign: Vec<Option<usize>> = sized
        .iter()
        .map(|s| s.map(|(size, _)| if thumb.is_some_and(|t| size.0 <= t.0) { 1 } else { 0 }))
        .collect();
    let renditions = sizes
        .iter()
        .enumerate()
        .map(|(i, &size)| {
            let mine = || assign.iter().zip(&sized).zip(wants).filter(move |((a, _), _)| **a == Some(i));
            let fps = mine().filter_map(|((_, s), _)| s.map(|s| s.1)).max().unwrap_or(VISIBLE_FPS);
            let cap = mine().filter_map(|(_, (_, c))| *c).min();
            Rendition { size, fps, kbps: kbps_for(size, fps, cap) }
        })
        .collect();
    Plan { renditions, assign }
}

// ---- which encoder -------------------------------------------------------------

/// Which hardware encoder a rendition runs on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Choice {
    /// Media Foundation's hardware MFT on the adapter that captured the frame.
    Mf,
    /// NVENC through `nvEncodeAPI64.dll`; `cross` when the frame has to be
    /// carried there from another adapter first (`gpu::Bridge`).
    Nvenc { cross: bool },
}

/// Whether NVENC across adapters beat the capturing adapter's own MFT when
/// measured (SCREENS.md, Probe). Set from the probe, not from a guess: on the
/// hybrid laptop the two tied on latency (p50 13–19 ms either way), because
/// NVENC's faster encode is spent on the system-memory carry.
pub const CROSS_NVENC_WINS: bool = false;

/// The encoder for a machine, decided from what it has:
///
/// - `forced` (`VOLERY_CAST_ENCODER=mf|nvenc`) wins when it can be honoured,
///   so the two can be compared on the same machine without a rebuild;
/// - an NVIDIA adapter that drives the output itself gets NVENC — no copy,
///   and NVIDIA's MFT is the one that would not activate here;
/// - otherwise the owner's own MFT, unless NVENC across adapters measured
///   better (`cross_wins`);
/// - NVENC across adapters when the owner has no MFT at all.
pub fn choose(owner_is_nvidia: bool, mf_on_owner: bool, nvenc: bool, cross_wins: bool, forced: Option<&str>) -> Option<Choice> {
    let nv = Choice::Nvenc { cross: !owner_is_nvidia };
    match forced {
        Some("mf") if mf_on_owner => return Some(Choice::Mf),
        Some("nvenc") if nvenc => return Some(nv),
        _ => {}
    }
    if owner_is_nvidia && nvenc {
        return Some(nv);
    }
    if mf_on_owner && !(nvenc && cross_wins) {
        return Some(Choice::Mf);
    }
    nvenc.then_some(nv)
}

// ---- the queue a viewer drops into -------------------------------------------

/// How many video frames may wait for a slow viewer before it is behind: one
/// being written and one more. Past that, a frame is older than the next one
/// will be by the time it lands, and sending it is latency.
pub const MAX_QUEUED_VIDEO: usize = 2;

/// The pure half of `Outbox`: what to keep when a viewer cannot keep up.
#[derive(Default)]
pub struct Queue {
    items: VecDeque<Out>,
    video: usize,
    dropping: bool,
    want_key: bool,
}

fn kind(o: &Out) -> Option<u8> {
    match o {
        Out::Binary(b) => b.first().copied(),
        Out::Text(_) => None,
    }
}

impl Queue {
    pub fn push(&mut self, out: Out) {
        match kind(&out) {
            Some(wire::VIDEO) if out.is_keyframe() => {
                // A keyframe supersedes every frame still waiting.
                self.purge_video();
                self.dropping = false;
                self.video += 1;
                self.items.push_back(out);
            }
            Some(wire::VIDEO) => {
                if self.dropping {
                    return;
                }
                if self.video >= MAX_QUEUED_VIDEO {
                    self.purge_video();
                    self.dropping = true;
                    self.want_key = true;
                    return;
                }
                self.video += 1;
                self.items.push_back(out);
            }
            Some(wire::CURSOR_POS) => {
                // Only where the pointer is now matters.
                match self.items.iter_mut().find(|o| kind(o) == Some(wire::CURSOR_POS)) {
                    Some(slot) => *slot = out,
                    None => self.items.push_back(out),
                }
            }
            _ => self.items.push_back(out),
        }
    }

    fn purge_video(&mut self) {
        self.items.retain(|o| kind(o) != Some(wire::VIDEO));
        self.video = 0;
    }

    pub fn pop(&mut self) -> Option<Out> {
        let o = self.items.pop_front()?;
        if kind(&o) == Some(wire::VIDEO) {
            self.video -= 1;
        }
        Some(o)
    }

    /// Whether the viewer fell behind since last asked: its owner calls
    /// `Subscription::key` so the drop ends at the next keyframe rather than
    /// the next natural one, which with an infinite GOP is never.
    pub fn take_key_request(&mut self) -> bool {
        std::mem::take(&mut self.want_key)
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }
}

/// A `Viewer` that is a queue: `send` never blocks, and whoever writes to the
/// socket (or the flyway stream) pops from the other end on its own thread.
/// The loopback socket and the flyway both use this, so "a slow viewer drops
/// until a keyframe" is decided in one place.
#[derive(Default)]
pub struct Outbox {
    q: Mutex<Queue>,
    ready: Condvar,
    closed: AtomicBool,
}

impl Outbox {
    pub fn new() -> Arc<Outbox> {
        Arc::new(Outbox::default())
    }

    /// The next message, waiting up to `timeout`. `None` on timeout or once
    /// closed and drained.
    pub fn pop(&self, timeout: Duration) -> Option<Out> {
        let mut q = self.q.lock().unwrap();
        if let Some(o) = q.pop() {
            return Some(o);
        }
        if self.closed.load(Ordering::SeqCst) {
            return None;
        }
        q = self.ready.wait_timeout(q, timeout).unwrap().0;
        q.pop()
    }

    pub fn take_key_request(&self) -> bool {
        self.q.lock().unwrap().take_key_request()
    }

    /// Stop accepting: the hub forgets this viewer at its next send.
    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.ready.notify_all();
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }
}

impl Viewer for Outbox {
    fn send(&self, out: Out) -> bool {
        if self.closed.load(Ordering::SeqCst) {
            return false;
        }
        self.q.lock().unwrap().push(out);
        self.ready.notify_one();
        true
    }
}

// ---- text messages ---------------------------------------------------------------

pub fn state_text(state: &str, why: Option<&str>) -> Out {
    let v = match why {
        Some(w) => serde_json::json!({ "t": "state", "state": state, "why": w }),
        None => serde_json::json!({ "t": "state", "state": state }),
    };
    Out::Text(v.to_string().into())
}

pub fn config_text(codec: &str, w: u32, h: u32, fps: u32) -> Out {
    Out::Text(serde_json::json!({ "t": "config", "codec": codec, "w": w, "h": h, "fps": fps }).to_string().into())
}

// ---- the live hub (Windows) ----------------------------------------------------

#[cfg(windows)]
pub use live::*;

#[cfg(windows)]
mod live {
    use super::*;
    use crate::cast::capture::{Cursor, Duplicator, Lost, Opened, Pointer};
    use crate::cast::encode::{self, codec_string, Encoder, ParamSets, Settings};
    use crate::cast::gpu::{Gpu, Scaler};
    use crate::cast::nvenc::Nvenc;
    use windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;
    use windows::Win32::Graphics::Dxgi::IDXGIAdapter1;
    use crate::cast::{monitors, Monitor};
    use std::collections::HashMap;
    use std::sync::atomic::AtomicU64;
    use std::sync::OnceLock;
    use std::time::Instant;

    static NEXT: AtomicU64 = AtomicU64::new(1);

    fn sources() -> &'static Mutex<HashMap<String, Arc<Source>>> {
        static S: OnceLock<Mutex<HashMap<String, Arc<Source>>>> = OnceLock::new();
        S.get_or_init(Default::default)
    }

    struct Sub {
        id: u64,
        want: Want,
        cap: Option<u32>,
        viewer: Arc<dyn Viewer>,
        /// The rendition token this viewer takes, `None` while paused.
        rendition: Option<u64>,
        /// Waiting for a keyframe before any delta means anything.
        awaiting_key: bool,
        key_requested: bool,
        config: Option<String>,
        said: &'static str,
        /// Has had the current cursor shape and position.
        cursor_sent: bool,
        dead: bool,
    }

    #[derive(Default)]
    struct Subs {
        list: Vec<Sub>,
        /// Bumped by every change the capture thread must re-plan for.
        gen: u64,
        cursor: Option<Arc<[u8]>>,
        pointer: Option<Arc<[u8]>>,
    }

    struct Source {
        monitor: Monitor,
        subs: Mutex<Subs>,
        stop: AtomicBool,
    }

    impl Source {
        fn say(sub: &mut Sub, state: &'static str, why: Option<&str>) {
            if sub.said != state {
                sub.said = state;
                if !sub.viewer.send(state_text(state, why)) {
                    sub.dead = true;
                }
            }
        }
    }

    /// A viewer's hold on a monitor. Dropping it unsubscribes; the last one
    /// gone stops the capture.
    pub struct Subscription {
        source: Arc<Source>,
        id: u64,
    }

    impl Subscription {
        fn with<R>(&self, f: impl FnOnce(&mut Sub, &mut u64) -> R) -> Option<R> {
            let mut s = self.source.subs.lock().unwrap();
            let Subs { list, gen, .. } = &mut *s;
            list.iter_mut().find(|x| x.id == self.id).map(|x| f(x, gen))
        }

        pub fn want(&self, w: Want) {
            self.with(|s, gen| {
                if s.want != w {
                    s.want = w;
                    *gen += 1;
                }
            });
        }

        /// The viewer lost its place: its rendition's next frame is a keyframe.
        pub fn key(&self) {
            self.with(|s, _| s.key_requested = true);
        }

        /// A ceiling on this viewer's bitrate (the flyway, steering to the
        /// path). Shared renditions take the lowest cap among their viewers.
        pub fn cap(&self, kbps: Option<u32>) {
            self.with(|s, gen| {
                if s.cap != kbps {
                    s.cap = kbps;
                    *gen += 1;
                }
            });
        }
    }

    impl Drop for Subscription {
        fn drop(&mut self) {
            let mut all = sources().lock().unwrap();
            let mut s = self.source.subs.lock().unwrap();
            s.list.retain(|x| x.id != self.id);
            s.gen += 1;
            if s.list.is_empty() {
                self.source.stop.store(true, Ordering::SeqCst);
                if all.get(&self.source.monitor.id).is_some_and(|x| Arc::ptr_eq(x, &self.source)) {
                    all.remove(&self.source.monitor.id);
                }
            }
        }
    }

    pub fn subscribe(monitor: &str, want: Want, viewer: Arc<dyn Viewer>) -> Result<Subscription, String> {
        let mut all = sources().lock().unwrap();
        let source = match all.get(monitor) {
            Some(s) => s.clone(),
            None => {
                let m = monitors::list().into_iter().find(|m| m.id == monitor).ok_or_else(|| format!("no monitor {monitor} on this machine"))?;
                let s = Arc::new(Source { monitor: m, subs: Mutex::default(), stop: AtomicBool::new(false) });
                let t = s.clone();
                std::thread::Builder::new()
                    .name(format!("cast-capture-{monitor}"))
                    .spawn(move || capture_thread(t))
                    .map_err(|e| e.to_string())?;
                all.insert(monitor.to_string(), s.clone());
                s
            }
        };
        let id = NEXT.fetch_add(1, Ordering::SeqCst);
        let mut s = source.subs.lock().unwrap();
        s.list.push(Sub {
            id,
            want,
            cap: None,
            viewer,
            rendition: None,
            awaiting_key: true,
            key_requested: false,
            config: None,
            said: "",
            cursor_sent: false,
            dead: false,
        });
        s.gen += 1;
        drop(s);
        Ok(Subscription { source, id })
    }

    /// A rendition's encoder, whichever it is.
    enum Engine {
        Mf { scaler: Scaler, encoder: Encoder },
        Nv(Nvenc),
    }

    impl Engine {
        fn set_kbps(&mut self, kbps: u32) {
            match self {
                Engine::Mf { encoder, .. } => encoder.set_kbps(kbps),
                Engine::Nv(n) => n.set_kbps(kbps),
            }
        }

        /// Convert and hand over one frame. `Ok(false)` is a frame skipped
        /// because the encoder holds every buffer it has.
        fn feed(&mut self, from: &Gpu, latest: &ID3D11Texture2D, time: i64, fps: u32, key: bool) -> Result<bool, String> {
            match self {
                Engine::Mf { scaler, encoder } => {
                    let Some(slot) = encoder.slot() else { return Ok(false) };
                    scaler.blt(from, latest, &slot.texture, slot.index).map_err(|e| format!("converting a frame: {e}"))?;
                    encoder.submit(slot, time, 10_000_000 / fps.max(1) as i64, key).map_err(|e| e.to_string())?;
                    Ok(true)
                }
                Engine::Nv(n) => n.submit(latest, time, key).map(|()| true),
            }
        }
    }

    /// The NVIDIA adapter, if this machine has one and its driver's NVENC loads.
    fn nvidia() -> Option<IDXGIAdapter1> {
        crate::cast::nvenc::available().ok()?;
        crate::cast::gpu::adapters().ok()?.into_iter().find(|a| unsafe { a.GetDesc1() }.map(|d| d.VendorId == 0x10de).unwrap_or(false))
    }

    fn is_nvidia(gpu: &Gpu) -> bool {
        crate::cast::gpu::adapter_by_luid(gpu.luid).ok().and_then(|a| unsafe { a.GetDesc1() }.ok()).map(|d| d.VendorId == 0x10de).unwrap_or(false)
    }

    /// Make the encoder `choose` names for one rendition, falling back to the
    /// other when the first will not start.
    fn engine(dup: &Duplicator, nv_gpu: &mut Option<Arc<Gpu>>, r: &Rendition, source: &Arc<Source>, token: u64) -> Result<(Engine, String), String> {
        let settings = Settings { w: r.size.0, h: r.size.1, fps: r.fps, kbps: r.kbps, rgb: false };
        let nv_adapter = nvidia();
        let owner_is_nvidia = is_nvidia(&dup.gpu);
        let mf_on_owner = encode::hardware_h264(Some(dup.gpu.luid)).map(|v| !v.is_empty()).unwrap_or(false);
        let forced = std::env::var("VOLERY_CAST_ENCODER").ok();
        let first = choose(owner_is_nvidia, mf_on_owner, nv_adapter.is_some(), CROSS_NVENC_WINS, forced.as_deref())
            .ok_or("no hardware H.264 encoder on this machine")?;
        let make_mf = || -> Result<(Engine, String), String> {
            let scaler = Scaler::new(&dup.gpu, dup.size, r.size, r.fps).map_err(|e| format!("video processor: {e}"))?;
            let encoder = Encoder::new(&dup.gpu, settings, fan_out(source.clone(), token, r.fps, "mf")).map_err(|e| format!("encoder: {e}"))?;
            let name = encoder.name.clone();
            Ok((Engine::Mf { scaler, encoder }, name))
        };
        let mut make_nv = || -> Result<(Engine, String), String> {
            let g = if owner_is_nvidia {
                dup.gpu.clone()
            } else if let Some(g) = nv_gpu.as_ref() {
                g.clone()
            } else {
                let a = nv_adapter.as_ref().ok_or("no NVIDIA adapter")?;
                let g = Arc::new(Gpu::open(a).map_err(|e| format!("a device on the NVIDIA adapter: {e}"))?);
                *nv_gpu = Some(g.clone());
                g
            };
            let n = Nvenc::new(dup.gpu.clone(), g, dup.size, settings, fan_out(source.clone(), token, r.fps, "nvenc"))?;
            let name = n.name.clone();
            Ok((Engine::Nv(n), name))
        };
        match first {
            Choice::Mf => make_mf().or_else(|e| {
                log::warn!("cast: the MFT would not start ({e}); trying NVENC");
                make_nv()
            }),
            Choice::Nvenc { .. } => make_nv().or_else(|e| {
                log::warn!("cast: NVENC would not start ({e}); trying the MFT");
                make_mf()
            }),
        }
    }

    /// One encoder at one size, as the capture thread holds it.
    struct Live {
        token: u64,
        plan: Rendition,
        engine: Engine,
        last_fed: Option<Instant>,
        dirty: bool,
        key: bool,
        /// One more encode of a still screen after motion stops: a CBR frame
        /// under motion is soft, and the encoder only sharpens what it is fed.
        refine: bool,
    }

    fn broadcast(source: &Source, out: &Out, only_visible: bool) {
        let mut s = source.subs.lock().unwrap();
        for sub in s.list.iter_mut() {
            if (!only_visible || sub.rendition.is_some()) && !sub.viewer.send(out.clone()) {
                sub.dead = true;
            }
        }
    }

    /// The encoder's output, on its event thread: stamp it, then hand the
    /// same bytes to every viewer of this rendition that can use them.
    fn fan_out(source: Arc<Source>, token: u64, fps: u32, encoder: &'static str) -> Box<dyn FnMut(encode::Encoded) + Send> {
        let mut seq = 0u32;
        let mut sets = ParamSets::default();
        let mut codec = None::<String>;
        let mut window = (Instant::now(), 0usize, 0usize, 0f64);
        Box::new(move |e| {
            let au = sets.ensure(&e.annex_b);
            if e.key {
                if let Some(c) = codec_string(&au) {
                    codec = Some(c);
                }
            }
            let (w, h) = au_size(&source, token);
            let capture_us = (e.time / 10) as u64;
            let encoded_us = crate::cast::capture::wall_us();
            let msg: Arc<[u8]> = wire::video(
                &wire::VideoHeader { key: e.key, w: w as u16, h: h as u16, seq, capture_us, encoded_us },
                &au,
            )
            .into();
            seq = seq.wrapping_add(1);
            window.1 += 1;
            window.2 += au.len();
            window.3 += encoded_us.saturating_sub(capture_us) as f64 / 1000.0;
            let stats = (window.0.elapsed() >= Duration::from_secs(1)).then(|| {
                let secs = window.0.elapsed().as_secs_f64();
                let o = Out::Text(
                    serde_json::json!({
                        "t": "stats",
                        "fps": (window.1 as f64 / secs).round(),
                        "kbps": (window.2 as f64 * 8.0 / secs / 1000.0).round(),
                        "encode_ms": (window.3 / window.1.max(1) as f64 * 10.0).round() / 10.0,
                        "encoder": encoder,
                        "w": w, "h": h,
                    })
                    .to_string()
                    .into(),
                );
                window = (Instant::now(), 0, 0, 0.0);
                o
            });
            let mut s = source.subs.lock().unwrap();
            for sub in s.list.iter_mut().filter(|x| x.rendition == Some(token)) {
                if sub.awaiting_key && !e.key {
                    continue;
                }
                if e.key {
                    sub.awaiting_key = false;
                    if let Some(c) = &codec {
                        let cfg = format!("{c}/{w}x{h}@{fps}");
                        if sub.config.as_deref() != Some(&cfg) {
                            sub.config = Some(cfg);
                            if !sub.viewer.send(config_text(c, w, h, fps)) {
                                sub.dead = true;
                            }
                        }
                    }
                }
                if !sub.viewer.send(Out::Binary(msg.clone())) {
                    sub.dead = true;
                }
                if let Some(st) = &stats {
                    let _ = sub.viewer.send(st.clone());
                }
            }
        })
    }

    /// The size a rendition token encodes at, told the fan-out through a
    /// table rather than captured, because a token's size never changes —
    /// a new size is a new token.
    fn sizes() -> &'static Mutex<HashMap<u64, (u32, u32)>> {
        static S: OnceLock<Mutex<HashMap<u64, (u32, u32)>>> = OnceLock::new();
        S.get_or_init(Default::default)
    }

    fn au_size(_: &Source, token: u64) -> (u32, u32) {
        sizes().lock().unwrap().get(&token).copied().unwrap_or((0, 0))
    }

    fn capture_thread(source: Arc<Source>) {
        encode::mta();
        let _fine = crate::cast::capture::FineTimer::hold();
        crate::cast::capture::urgent();
        if let Err(e) = run(&source) {
            log::warn!("cast: capture of {} ended: {e}", source.monitor.id);
            broadcast(&source, &state_text("ended", Some(&e)), false);
        }
    }

    fn open(source: &Source) -> Result<Duplicator, String> {
        let mut said_locked = false;
        loop {
            if source.stop.load(Ordering::SeqCst) {
                return Err("stopped".into());
            }
            let (adapter, output) = monitors::open(&source.monitor.id)?;
            let gpu = Arc::new(Gpu::open(&adapter).map_err(|e| format!("a device on {}: {e}", source.monitor.name))?);
            match Duplicator::open(gpu, output) {
                Opened::Ok(d) => return Ok(d),
                Opened::Locked => {
                    if !said_locked {
                        let mut s = source.subs.lock().unwrap();
                        for sub in s.list.iter_mut() {
                            Source::say(sub, "locked", Some("the secure desktop has the screen"));
                        }
                        said_locked = true;
                    }
                    std::thread::sleep(Duration::from_millis(250));
                }
                Opened::Failed(e) => return Err(e),
            }
        }
    }

    fn run(source: &Arc<Source>) -> Result<(), String> {
        let mut dup = open(source)?;
        let mut live: Vec<Live> = Vec::new();
        let mut nv_gpu: Option<Arc<Gpu>> = None;
        let mut planned_gen = u64::MAX;
        let mut frame_wall_us = crate::cast::capture::wall_us();
        let mut last_time = 0i64;
        let mut last_motion = Instant::now();
        let hz = source.monitor.hz;

        while !source.stop.load(Ordering::SeqCst) {
            // Re-plan when the wants changed; take key requests either way.
            {
                let mut s = source.subs.lock().unwrap();
                s.list.retain(|x| !x.dead);
                if s.gen != planned_gen {
                    planned_gen = s.gen;
                    let wants: Vec<(Want, Option<u32>)> = s.list.iter().map(|x| (x.want, x.cap)).collect();
                    let p = plan(dup.size, hz, &wants);
                    let mut next: Vec<Live> = Vec::new();
                    for r in &p.renditions {
                        let reuse = live.iter().position(|l| l.plan.size == r.size);
                        let l = match reuse {
                            Some(i) => {
                                let mut l = live.remove(i);
                                if l.plan.kbps != r.kbps {
                                    l.engine.set_kbps(r.kbps);
                                }
                                l.plan = *r;
                                l
                            }
                            None => {
                                let token = NEXT.fetch_add(1, Ordering::SeqCst);
                                sizes().lock().unwrap().insert(token, r.size);
                                let (engine, name) = engine(&dup, &mut nv_gpu, r, source, token)?;
                                log::info!("cast: {} at {}x{}@{} on {name}", source.monitor.id, r.size.0, r.size.1, r.fps);
                                Live { token, plan: *r, engine, last_fed: None, dirty: true, key: true, refine: false }
                            }
                        };
                        next.push(l);
                    }
                    for old in live.drain(..) {
                        sizes().lock().unwrap().remove(&old.token);
                    }
                    live = next;
                    let cursor = s.cursor.clone();
                    let pointer = s.pointer.clone();
                    for (sub, a) in s.list.iter_mut().zip(&p.assign) {
                        let token = a.map(|i| live[i].token);
                        if sub.rendition != token {
                            sub.rendition = token;
                            if let Some(i) = *a {
                                sub.awaiting_key = true;
                                live[i].key = true;
                            }
                        }
                        if sub.rendition.is_some() {
                            Source::say(sub, "live", None);
                            if !sub.cursor_sent {
                                sub.cursor_sent = true;
                                for o in cursor.iter().chain(pointer.iter()) {
                                    let _ = sub.viewer.send(Out::Binary(o.clone()));
                                }
                            }
                        } else {
                            Source::say(sub, "paused", None);
                        }
                    }
                }
                for sub in s.list.iter_mut().filter(|x| x.key_requested) {
                    sub.key_requested = false;
                    if let Some(l) = live.iter_mut().find(|l| Some(l.token) == sub.rendition) {
                        l.key = true;
                    }
                }
            }

            let wait = if live.is_empty() { 100 } else { 4 };
            match dup.next(wait) {
                Ok(Some(t)) => {
                    if t.frame {
                        frame_wall_us = t.wall_us;
                        last_motion = Instant::now();
                        for l in live.iter_mut() {
                            l.dirty = true;
                            l.refine = true;
                        }
                    }
                    if let Some(c) = &t.shape {
                        let msg = shape_msg(c);
                        source.subs.lock().unwrap().cursor = Some(msg.clone());
                        broadcast(source, &Out::Binary(msg), true);
                    }
                    if let Some(p) = t.pointer.or(t.shape.as_ref().map(|_| dup.pointer())) {
                        let id = source.subs.lock().unwrap().cursor.as_ref().map(|c| u32::from_le_bytes(c[10..14].try_into().unwrap())).unwrap_or(0);
                        let msg: Arc<[u8]> = pos_msg(p, id).into();
                        source.subs.lock().unwrap().pointer = Some(msg.clone());
                        broadcast(source, &Out::Binary(msg), true);
                    }
                }
                Ok(None) => {}
                Err(Lost::Access) => {
                    // Mode change, a full-screen exclusive app, or the secure
                    // desktop. Re-duplicate; say `locked` while it refuses.
                    let mut said = false;
                    loop {
                        if source.stop.load(Ordering::SeqCst) {
                            return Ok(());
                        }
                        match dup.reopen() {
                            Ok(true) => break,
                            Ok(false) => {
                                if !said {
                                    said = true;
                                    let mut s = source.subs.lock().unwrap();
                                    for sub in s.list.iter_mut() {
                                        Source::say(sub, "locked", Some("the secure desktop has the screen"));
                                    }
                                }
                                std::thread::sleep(Duration::from_millis(250));
                            }
                            Err(e) => return Err(e),
                        }
                    }
                    // A new mode may be a new size: re-plan from scratch.
                    live.clear();
                    planned_gen = u64::MAX;
                    let mut s = source.subs.lock().unwrap();
                    for sub in s.list.iter_mut() {
                        sub.rendition = None;
                        sub.said = "";
                    }
                    continue;
                }
                Err(Lost::Other(e)) => return Err(e),
            }

            let now = Instant::now();
            for l in live.iter_mut() {
                let interval = Duration::from_secs_f64(1.0 / l.plan.fps.max(1) as f64);
                let due = l.last_fed.is_none_or(|t| now.duration_since(t) >= interval);
                let settle = l.refine && !l.dirty && now.duration_since(last_motion) >= Duration::from_millis(120);
                if !(due && (l.dirty || l.key || settle)) {
                    continue;
                }
                // Sample times must rise; the capture's own clock is the base.
                let time = (frame_wall_us as i64 * 10).max(last_time + 1);
                let key = std::mem::take(&mut l.key);
                match l.engine.feed(&dup.gpu, &dup.latest, time, l.plan.fps, key) {
                    Ok(true) => last_time = time,
                    Ok(false) => {
                        l.key = key;
                        continue;
                    }
                    Err(e) => {
                        log::warn!("cast: encoder refused a frame: {e}");
                        l.key = key;
                        continue;
                    }
                }
                if settle {
                    l.refine = false;
                }
                l.dirty = false;
                l.last_fed = Some(now);
            }
        }
        for l in live.drain(..) {
            sizes().lock().unwrap().remove(&l.token);
        }
        Ok(())
    }

    fn shape_msg(c: &Cursor) -> Arc<[u8]> {
        wire::cursor_shape(c.w, c.h, c.hot_x, c.hot_y, c.id, &c.rgba).into()
    }

    fn pos_msg(p: Pointer, shape: u32) -> Vec<u8> {
        let clamp = |v: i32| v.clamp(i16::MIN as i32, i16::MAX as i32) as i16;
        wire::cursor_pos(p.visible, clamp(p.x), clamp(p.y), shape).to_vec()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn want(w: u32, h: u32, visible: bool, focused: bool) -> Want {
        Want { w, h, fps: 0, visible, focused }
    }

    #[test]
    fn fps_follows_the_table() {
        assert_eq!(fps_for(&want(2560, 1440, true, true), 240), 120);
        assert_eq!(fps_for(&want(2560, 1440, true, true), 60), 60);
        assert_eq!(fps_for(&want(1280, 720, true, false), 240), 30);
        assert_eq!(fps_for(&want(320, 180, true, false), 240), 15);
        assert_eq!(fps_for(&want(1280, 720, false, false), 240), 0);
        assert_eq!(fps_for(&Want { fps: 24, ..want(1280, 720, true, true) }, 240), 24);
    }

    #[test]
    fn a_rendition_covers_the_tile_on_a_ladder_and_never_exceeds_native() {
        let native = (2560, 1440);
        assert_eq!(rung(native, (4000, 3000)), (2560, 1440));
        assert_eq!(rung(native, (2560, 1440)), (2560, 1440));
        assert_eq!(rung(native, (1280, 720)), (1280, 720));
        // A few pixels either way lands on the same rung: no rebuild per drag.
        assert_eq!(rung(native, (1250, 700)), rung(native, (1270, 715)));
        assert_eq!(rung(native, (1300, 720)), (1280, 720));
        assert_eq!(rung(native, (1300, 800)), (1706, 960));
        assert_eq!(rung(native, (300, 160)), (320, 180));
        assert_eq!(rung(native, (10, 10)), (320, 180));
    }

    #[test]
    fn many_wants_collapse_into_a_large_rendition_and_a_thumbnail() {
        let native = (2560, 1440);
        let p = plan(
            native,
            240,
            &[
                (want(2560, 1440, true, true), None),
                (want(400, 225, true, false), None),
                (want(1200, 700, true, false), None),
                (want(1280, 720, false, false), None),
            ],
        );
        assert_eq!(p.renditions.len(), 2);
        assert_eq!(p.renditions[0].size, (2560, 1440));
        assert_eq!(p.renditions[0].fps, 120);
        // The thumbnail is the largest want that is half the big one or less.
        assert_eq!(p.renditions[1].size, (1280, 720));
        assert_eq!(p.renditions[1].fps, 30);
        assert_eq!(p.assign, vec![Some(0), Some(1), Some(1), None]);
    }

    #[test]
    fn nobody_visible_means_nothing_encoded_and_caps_take_the_minimum() {
        let p = plan((1920, 1080), 60, &[(want(1920, 1080, false, false), Some(500))]);
        assert!(p.renditions.is_empty());
        assert_eq!(p.assign, vec![None]);
        let p = plan(
            (1920, 1080),
            60,
            &[(want(1920, 1080, true, false), Some(3000)), (want(1900, 1060, true, false), Some(1500))],
        );
        assert_eq!(p.renditions.len(), 1);
        assert_eq!(p.renditions[0].kbps, 1500);
        assert_eq!(kbps_for((2560, 1440), 120, None), 35389);
        assert_eq!(kbps_for((320, 180), 15, None), 400);
    }

    #[test]
    fn the_encoder_is_the_owners_unless_nvidia_owns_the_output_or_nothing_else_will_do() {
        // The hybrid laptop: Intel owns the panel and has an MFT; NVENC is across.
        assert_eq!(choose(false, true, true, false, None), Some(Choice::Mf));
        assert_eq!(choose(false, true, true, true, None), Some(Choice::Nvenc { cross: true }));
        // A desktop with the NVIDIA card driving the monitor: no copy.
        assert_eq!(choose(true, true, true, false, None), Some(Choice::Nvenc { cross: false }));
        // No MFT on the owner at all: NVENC across, or nothing.
        assert_eq!(choose(false, false, true, false, None), Some(Choice::Nvenc { cross: true }));
        assert_eq!(choose(false, false, false, false, None), None);
        // Forcing wins where it can be honoured, and only there.
        assert_eq!(choose(false, true, true, false, Some("nvenc")), Some(Choice::Nvenc { cross: true }));
        assert_eq!(choose(true, true, true, false, Some("mf")), Some(Choice::Mf));
        assert_eq!(choose(false, true, false, false, Some("nvenc")), Some(Choice::Mf));
    }

    fn video(key: bool, seq: u32) -> Out {
        let h = wire::VideoHeader { key, w: 1, h: 1, seq, capture_us: 0, encoded_us: 0 };
        Out::Binary(wire::video(&h, &[]).into())
    }

    fn seqs(q: &mut Queue) -> Vec<String> {
        let mut out = Vec::new();
        while let Some(o) = q.pop() {
            out.push(match &o {
                Out::Binary(b) if b[0] == wire::VIDEO => {
                    let (h, _) = wire::read_video(b).unwrap();
                    format!("{}{}", if h.key { "K" } else { "v" }, h.seq)
                }
                Out::Binary(b) if b[0] == wire::CURSOR_POS => format!("p{}", b[2]),
                Out::Binary(_) => "shape".into(),
                Out::Text(t) => t.to_string(),
            });
        }
        out
    }

    #[test]
    fn a_slow_viewer_drops_until_the_next_keyframe_and_asks_for_one() {
        let mut q = Queue::default();
        q.push(video(true, 0));
        q.push(video(false, 1));
        // Two queued: the third is one too many. Everything video goes.
        q.push(video(false, 2));
        assert!(q.take_key_request());
        assert!(!q.take_key_request());
        q.push(video(false, 3));
        q.push(Out::Text("{\"t\":\"stats\"}".into()));
        q.push(video(true, 4));
        q.push(video(false, 5));
        assert_eq!(seqs(&mut q), vec!["{\"t\":\"stats\"}", "K4", "v5"]);
    }

    #[test]
    fn a_keyframe_supersedes_waiting_frames_and_pointer_moves_coalesce() {
        let mut q = Queue::default();
        q.push(video(false, 1));
        q.push(Out::Binary(wire::cursor_pos(true, 1, 0, 0).to_vec().into()));
        q.push(Out::Binary(wire::cursor_shape(1, 1, 0, 0, 3, &[0; 4]).into()));
        q.push(Out::Binary(wire::cursor_pos(true, 2, 0, 0).to_vec().into()));
        q.push(video(true, 2));
        assert_eq!(seqs(&mut q), vec!["p2", "shape", "K2"]);
    }

    #[test]
    fn an_outbox_refuses_once_closed() {
        let o = Outbox::new();
        assert!(o.send(video(true, 0)));
        o.close();
        assert!(!o.send(video(true, 1)));
        assert!(o.pop(Duration::from_millis(1)).is_some());
        assert!(o.pop(Duration::from_millis(1)).is_none());
    }
}
