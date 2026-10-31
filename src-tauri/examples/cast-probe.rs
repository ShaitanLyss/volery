/* What a screen on the wall costs on this machine, measured through the code
 * that ships rather than a rehearsal of it.
 *
 *   cargo run --example cast-probe                       # every monitor, 5s each, native size
 *   cargo run --example cast-probe -- --secs 10 --size 1280x720 --fps 60
 *   cargo run --example cast-probe -- --monitor <id>     # one monitor (ids are printed first)
 *
 * It answers, in order:
 *
 *   1. the adapters, their outputs, and every hardware H.264 encoder Media
 *      Foundation offers, with the adapter each runs on (MFT_ENUM_ADAPTER_LUID);
 *   2. per monitor: duplicate it on the adapter that owns it, convert and scale
 *      BGRA → NV12 with the D3D11 video processor, encode with that adapter's
 *      hardware MFT, and report capture→encoded latency p50/p95/max, achieved
 *      fps and bitrate over a moving scene this probe draws itself (a screen at
 *      rest makes no frames, and the number wanted is the one under motion);
 *   3. whether every IDR carries SPS and PPS in-band and a forced keyframe
 *      arrives when asked for;
 *   4. the exclusion: a magenta window with WDA_EXCLUDEFROMCAPTURE and a green
 *      control window without it, read back out of the duplicated frame. The
 *      control is what makes "magenta is absent" mean something — without it, a
 *      probe that captured nothing at all would pass.
 *
 * Every stream is written to `.scratch-$SKEIN_CARD/cast-<monitor>.h264` and
 * handed to ffprobe when there is one on PATH.
 *
 * The windows flash briefly in a corner of each monitor; nothing is clicked or
 * typed, and they take no focus.
 */

#[cfg(not(windows))]
fn main() {
    eprintln!("cast-probe is Windows-only");
}

#[cfg(windows)]
fn main() {
    probe::run();
}

#[cfg(windows)]
mod probe {
    use skein_lib::cast::capture::{wall_us, Duplicator, Opened};
    use skein_lib::cast::encode::{self, codec_string, nals, Encoder, Settings, NAL_IDR, NAL_PPS, NAL_SPS};
    use skein_lib::cast::gpu::{self, Gpu, Scaler};
    use skein_lib::cast::monitors;
    use std::collections::HashMap;
    use std::io::Write;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows::Win32::Graphics::Gdi::*;
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
    use windows::Win32::UI::WindowsAndMessaging::*;

    struct Args {
        secs: u64,
        size: Option<(u32, u32)>,
        fps: u32,
        monitor: Option<String>,
        encode_on: Option<u64>,
        serve: bool,
        rgb: bool,
    }

    fn args() -> Args {
        let mut a = Args { secs: 5, size: None, fps: 60, monitor: None, encode_on: None, serve: false, rgb: false };
        let mut it = std::env::args().skip(1);
        while let Some(k) = it.next() {
            match k.as_str() {
                "--secs" => a.secs = it.next().and_then(|v| v.parse().ok()).unwrap_or(5),
                "--fps" => a.fps = it.next().and_then(|v| v.parse().ok()).unwrap_or(60),
                "--monitor" => a.monitor = it.next(),
                "--serve" => a.serve = true,
                "--rgb" => a.rgb = true,
                "--encode-on" => a.encode_on = it.next().and_then(|v| u64::from_str_radix(&v, 16).ok()),
                "--size" => {
                    a.size = it.next().and_then(|v| {
                        let (w, h) = v.split_once('x')?;
                        Some((w.parse().ok()?, h.parse().ok()?))
                    })
                }
                _ => {}
            }
        }
        a
    }

    fn scratch() -> std::path::PathBuf {
        let card = std::env::var("SKEIN_CARD").unwrap_or_else(|_| "probe".into());
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join(format!(".scratch-{card}"));
        let _ = std::fs::create_dir_all(&root);
        root
    }

    // ---- the windows the probe draws ----------------------------------------

    const COLOUR: WINDOW_LONG_PTR_INDEX = GWLP_USERDATA;

    unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
        unsafe {
            if msg == WM_PAINT {
                let mut ps = PAINTSTRUCT::default();
                let dc = BeginPaint(hwnd, &mut ps);
                let brush = CreateSolidBrush(COLORREF(GetWindowLongPtrW(hwnd, COLOUR) as u32));
                FillRect(dc, &ps.rcPaint, brush);
                let _ = DeleteObject(brush.into());
                let _ = EndPaint(hwnd, &ps);
                return LRESULT(0);
            }
            if msg == WM_ERASEBKGND {
                return LRESULT(1);
            }
            DefWindowProcW(hwnd, msg, wp, lp)
        }
    }

    fn window(x: i32, y: i32, w: i32, h: i32, bgr: u32) -> HWND {
        unsafe {
            let inst = GetModuleHandleW(None).unwrap();
            static CLASS: std::sync::Once = std::sync::Once::new();
            CLASS.call_once(|| {
                let wc = WNDCLASSW {
                    lpfnWndProc: Some(wndproc),
                    hInstance: inst.into(),
                    lpszClassName: w!("cast-probe"),
                    ..Default::default()
                };
                RegisterClassW(&wc);
            });
            let hwnd = CreateWindowExW(
                WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                w!("cast-probe"),
                PCWSTR::null(),
                WS_POPUP | WS_VISIBLE,
                x,
                y,
                w,
                h,
                None,
                None,
                Some(inst.into()),
                None,
            )
            .unwrap();
            SetWindowLongPtrW(hwnd, COLOUR, bgr as isize);
            let _ = InvalidateRect(Some(hwnd), None, true);
            hwnd
        }
    }

    fn pump() {
        unsafe {
            let mut m = MSG::default();
            while PeekMessageW(&mut m, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&m);
                DispatchMessageW(&m);
            }
        }
    }

    /// A moving scene: bars sweeping across a window, repainted every few
    /// milliseconds so DWM composes a new frame at the panel's own rate.
    fn animate(hwnd: HWND, t: f64) {
        unsafe {
            let dc = GetDC(Some(hwnd));
            let mut r = RECT::default();
            let _ = GetClientRect(hwnd, &mut r);
            let w = r.right;
            for i in 0..8 {
                let x = ((t * 600.0 + i as f64 * w as f64 / 8.0) as i32).rem_euclid(w.max(1));
                let c = (((t * 97.0) as u32 + i * 31) % 255) as u32;
                let brush = CreateSolidBrush(COLORREF(c | ((255 - c) << 8) | ((c * 7 % 255) << 16)));
                let bar = RECT { left: x, top: 0, right: x + w / 16, bottom: r.bottom };
                FillRect(dc, &bar, brush);
                let _ = DeleteObject(brush.into());
            }
            ReleaseDC(Some(hwnd), dc);
        }
    }

    // ---- the run ------------------------------------------------------------

    struct Out {
        latencies: Vec<f64>,
        held: Vec<f64>,
        fed: Vec<f64>,
        bytes: usize,
        frames: usize,
        keys: usize,
        keys_with_sets: usize,
        codec: Option<String>,
        first_at: Option<Instant>,
        last_at: Option<Instant>,
    }

    fn pct(v: &mut [f64], p: f64) -> f64 {
        if v.is_empty() {
            return f64::NAN;
        }
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        v[((v.len() - 1) as f64 * p).round() as usize]
    }

    struct Say;
    impl log::Log for Say {
        fn enabled(&self, _: &log::Metadata) -> bool {
            true
        }
        fn log(&self, r: &log::Record) {
            if r.target().starts_with("skein") {
                println!("  [{}] {}", r.level(), r.args());
            }
        }
        fn flush(&self) {}
    }

    pub fn run() {
        let _ = log::set_logger(&Say).map(|()| log::set_max_level(log::LevelFilter::Info));
        let a = args();
        unsafe {
            let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        }
        encode::mta();
        encode::start().expect("MFStartup");
        let _fine = (std::env::var_os("CAST_COARSE").is_none()).then(skein_lib::cast::capture::FineTimer::hold);
        println!("== system timer: {}", if _fine.is_some() { "1 ms (FineTimer held)" } else { "default (CAST_COARSE set)" });
        skein_lib::cast::capture::urgent();
        println!("== thread priority: {}", if std::env::var_os("CAST_NORMAL_PRIORITY").is_some() { "normal (CAST_NORMAL_PRIORITY set)" } else { "MMCSS Capture" });

        println!("== adapters");
        for ad in gpu::adapters().unwrap() {
            let d = unsafe { ad.GetDesc1().unwrap() };
            let mut outs = 0;
            while unsafe { ad.EnumOutputs(outs) }.is_ok() {
                outs += 1;
            }
            println!("  {:016x}  {}  outputs={}  vram={}MB", gpu::luid64(d.AdapterLuid), gpu::adapter_name(&ad), outs, d.DedicatedVideoMemory >> 20);
        }
        println!("== hardware H.264 encoders (NV12 in)");
        for c in encode::hardware_h264(None).unwrap() {
            let made: windows::core::Result<windows::Win32::Media::MediaFoundation::IMFTransform> = unsafe { c.activate.ActivateObject() };
            println!("  {}  {}  activates: {}", c.name, c.vendor.clone().unwrap_or_default(), match &made { Ok(_) => "yes".into(), Err(e) => e.to_string() });
            if let Ok(t) = &made {
                println!("    takes: {}", encode::input_subtypes(t).join(", "));
            }
            unsafe {
                let _ = c.activate.ShutdownObject();
            }
        }
        for ad in gpu::adapters().unwrap() {
            let l = gpu::luid64(unsafe { ad.GetDesc1().unwrap() }.AdapterLuid);
            let on: Vec<String> = encode::hardware_h264(Some(l)).map(|v| v.into_iter().map(|c| c.name).collect()).unwrap_or_else(|e| vec![e.to_string()]);
            println!("  asked for {l:016x}: {on:?}");
        }
        let list = monitors::list();
        println!("== monitors");
        for m in &list {
            println!("  {}  {}  {}x{}@{}Hz at ({},{}){}", m.id, m.name, m.w, m.h, m.hz, m.x, m.y, if m.primary { "  primary" } else { "" });
        }

        for m in list.iter().filter(|m| a.monitor.as_ref().is_none_or(|id| *id == m.id)) {
            if a.serve {
                println!("\n== {} through the loopback socket, as a tile sees it", m.id);
                if let Err(e) = serve(&a, m) {
                    println!("  FAILED: {e}");
                }
                continue;
            }
            println!("\n== {} ({})", m.id, m.name);
            if let Err(e) = one(&a, m) {
                println!("  FAILED: {e}");
            }
        }
    }

    /// `cast_open` → dial → want → frames: the whole path a tile takes, with
    /// the hub, the outbox and the socket in it. Also: a wrong token is refused.
    fn serve(a: &Args, m: &skein_lib::cast::Monitor) -> Result<(), String> {
        use skein_lib::cast::wire;
        use tungstenite::Message;
        let url = skein_lib::cast::local::open_bare(m.id.clone())?;
        println!("  minted {url}");
        let dial = |u: &str| {
            let addr = u.trim_start_matches("ws://").split('/').next().unwrap().to_string();
            let tcp = std::net::TcpStream::connect(addr).map_err(|e| e.to_string())?;
            tcp.set_nodelay(true).ok();
            tungstenite::client(u, tcp).map(|(ws, _)| ws).map_err(|e| e.to_string())
        };
        let wrong = url.replace("?t=", "?t=0");
        println!("  a wrong token: {}", match dial(&wrong) { Ok(_) => "ACCEPTED (bad)".to_string(), Err(e) => format!("refused ({e})") });
        let mut ws = dial(&url)?;
        let (w, h) = a.size.unwrap_or((1280, 720));
        ws.send(Message::text(format!(r#"{{"t":"want","w":{w},"h":{h},"fps":{},"visible":true,"focused":true}}"#, a.fps))).map_err(|e| e.to_string())?;
        ws.get_mut().set_read_timeout(Some(Duration::from_millis(200))).ok();
        let file = scratch().join(format!("cast-socket-{}.h264", m.id));
        let mut f = std::fs::File::create(&file).map_err(|e| e.to_string())?;
        let scene = window(m.x + 40, m.y + 40, 640, 360, 0x202020);
        let start = Instant::now();
        let (mut frames, mut keys, mut bytes, mut shapes, mut moves) = (0usize, 0usize, 0usize, 0usize, 0usize);
        let mut lat = Vec::new();
        let mut texts = Vec::new();
        let mut first_key = None;
        let mut asked_key = false;
        while start.elapsed() < Duration::from_secs(a.secs) {
            animate(scene, start.elapsed().as_secs_f64());
            pump();
            if !asked_key && start.elapsed() > Duration::from_secs(a.secs / 2) {
                asked_key = true;
                ws.send(Message::text(r#"{"t":"key"}"#)).ok();
            }
            match ws.read() {
                Ok(Message::Binary(b)) => match b.first().copied() {
                    Some(wire::VIDEO) => {
                        let (hd, au) = wire::read_video(&b).ok_or("a short video message")?;
                        frames += 1;
                        bytes += au.len();
                        if hd.key {
                            keys += 1;
                            first_key.get_or_insert(start.elapsed());
                        }
                        lat.push(wall_us().saturating_sub(hd.capture_us) as f64 / 1000.0);
                        f.write_all(au).ok();
                    }
                    Some(wire::CURSOR_SHAPE) => shapes += 1,
                    Some(wire::CURSOR_POS) => moves += 1,
                    _ => {}
                },
                Ok(Message::Text(t)) => {
                    if !t.contains("\"stats\"") || texts.iter().all(|x: &String| !x.contains("\"stats\"")) {
                        texts.push(t.to_string());
                    }
                }
                Ok(_) => {}
                Err(tungstenite::Error::Io(e)) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {}
                Err(e) => return Err(format!("socket: {e}")),
            }
        }
        let _ = ws.close(None);
        unsafe {
            let _ = DestroyWindow(scene);
        }
        pump();
        let secs = a.secs as f64;
        println!("  texts: {texts:?}");
        println!(
            "  {frames} frames ({keys} keys, first after {:?}), {:.1} fps, {:.2} Mbit/s; cursor shapes {shapes}, moves {moves}",
            first_key,
            frames as f64 / secs,
            bytes as f64 * 8.0 / secs / 1e6
        );
        println!("  capture → received over the socket: p50 {:.2} ms, p95 {:.2} ms", pct(&mut lat, 0.5), pct(&mut lat, 0.95));
        drop(f);
        match std::process::Command::new("ffprobe")
            .args(["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height,nb_read_frames", "-of", "compact"])
            .arg(&file)
            .output()
        {
            Ok(p) => println!("  ffprobe: {}{}", String::from_utf8_lossy(&p.stdout).trim(), String::from_utf8_lossy(&p.stderr).trim()),
            Err(_) => println!("  ffprobe: not on PATH"),
        }
        Ok(())
    }

    fn one(a: &Args, m: &skein_lib::cast::Monitor) -> Result<(), String> {
        let (adapter, output) = monitors::open(&m.id)?;
        let cap_gpu = Arc::new(Gpu::open(&adapter).map_err(|e| format!("device: {e}"))?);
        println!("  capture device on {} ({:016x})", cap_gpu.name, cap_gpu.luid);
        let gpu = match a.encode_on {
            Some(l) if l != cap_gpu.luid => {
                let g = Arc::new(Gpu::open(&gpu::adapter_by_luid(l).map_err(|e| e.to_string())?).map_err(|e| format!("device: {e}"))?);
                println!("  convert + encode on {} ({:016x}), frames carried across through system memory", g.name, g.luid);
                g
            }
            _ => cap_gpu.clone(),
        };
        let mut dup = match Duplicator::open(cap_gpu.clone(), output) {
            Opened::Ok(d) => d,
            Opened::Locked => return Err("the secure desktop has this output".into()),
            Opened::Failed(e) => return Err(e),
        };
        let src = dup.size;
        let even = |v: u32| v & !1;
        let dst = a.size.map(|(w, h)| (even(w), even(h))).unwrap_or((even(src.0), even(src.1)));
        let kbps = ((dst.0 as f64 * dst.1 as f64 * a.fps as f64 * 0.08) / 1000.0).clamp(1000.0, 40000.0) as u32;
        let rgb = a.rgb && dst == src;
        let settings = Settings { w: dst.0, h: dst.1, fps: a.fps, kbps, rgb };
        if a.rgb && !rgb {
            println!("  --rgb only at native size; converting to NV12 instead");
        }
        if rgb {
            println!("  feeding BGRA straight to the encoder (ARGB32), no video processor");
        }
        println!("  duplicating {}x{}, encoding {}x{}@{} at {} kbps CBR", src.0, src.1, dst.0, dst.1, a.fps, kbps);

        // Windows: the scene, the excluded square, the control square.
        let (x0, y0) = (m.x + 40, m.y + 40);
        let scene = window(x0, y0, 640, 360, 0x202020);
        let excluded = window(x0 + 660, y0, 200, 200, 0xFF00FF); // magenta (BGR)
        let control = window(x0 + 660, y0 + 220, 200, 200, 0x00FF00); // green
        let affinity = unsafe { SetWindowDisplayAffinity(excluded, WDA_EXCLUDEFROMCAPTURE) };
        println!("  SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE): {}", if affinity.is_ok() { "ok".to_string() } else { format!("{affinity:?}") });

        let captured: Arc<Mutex<HashMap<i64, Instant>>> = Default::default();
        let file = scratch().join(format!("cast-{}.h264", m.id));
        let sink = Arc::new(Mutex::new(std::fs::File::create(&file).map_err(|e| e.to_string())?));
        let out = Arc::new(Mutex::new(Out {
            latencies: Vec::new(),
            held: Vec::new(),
            fed: Vec::new(),
            bytes: 0,
            frames: 0,
            keys: 0,
            keys_with_sets: 0,
            codec: None,
            first_at: None,
            last_at: None,
        }));
        let (c2, o2, s2) = (captured.clone(), out.clone(), sink.clone());
        let mut sets = encode::ParamSets::default();
        let encoder = Encoder::new(
            &gpu,
            settings,
            Box::new(move |e| {
                let au = sets.ensure(&e.annex_b).into_owned();
                let mut o = o2.lock().unwrap();
                if let Some(t0) = c2.lock().unwrap().remove(&e.time) {
                    o.latencies.push(e.at.duration_since(t0).as_secs_f64() * 1000.0);
                    if let Some(h) = e.held {
                        o.held.push(h.as_secs_f64() * 1000.0);
                        o.fed.push((e.at.duration_since(t0) - h).as_secs_f64() * 1000.0);
                    }
                }
                o.bytes += e.annex_b.len();
                o.frames += 1;
                o.first_at.get_or_insert(e.at);
                o.last_at = Some(e.at);
                if e.key {
                    o.keys += 1;
                    let types: Vec<u8> = nals(&e.annex_b).iter().map(|n| n.0).collect();
                    if types.contains(&NAL_SPS) && types.contains(&NAL_PPS) && types.contains(&NAL_IDR) {
                        o.keys_with_sets += 1;
                    }
                    if o.codec.is_none() {
                        o.codec = codec_string(&au);
                    }
                }
                let _ = s2.lock().unwrap().write_all(&au);
            }),
        )
        .map_err(|e| format!("encoder: {e}"))?;
        println!("  encoder: {}", encoder.name);
        let mut scaler = Scaler::new(&gpu, src, dst, a.fps).map_err(|e| format!("video processor: {e}"))?;
        let bridge = if Arc::ptr_eq(&gpu, &cap_gpu) { None } else { Some(gpu::Bridge::new(&cap_gpu, &gpu, src).map_err(|e| format!("bridge: {e}"))?) };
        let mut carry_ms = Vec::new();

        let start = Instant::now();
        let mut last_feed = Instant::now() - Duration::from_secs(1);
        let interval = Duration::from_secs_f64(1.0 / a.fps as f64);
        let mut acquired = 0usize;
        let mut fed = 0usize;
        let mut skipped_pool = 0usize;
        let mut forced = 0usize;
        let mut exclusion: Option<(bool, bool)> = None;
        let mut next_key = start + Duration::from_secs(2);
        let mut dirty = false;
        /* Stamped at the acquire, as the hub stamps `capture_us`: a clock
           started at the feed instead would leave out the wait for the frame
           to fall due and the conversion, and read several ms short. */
        let mut frame_at = (wall_us() as i64 * 10, Instant::now());
        let mut last_time = 0i64;
        while start.elapsed() < Duration::from_secs(a.secs) {
            animate(scene, start.elapsed().as_secs_f64());
            pump();
            match dup.next(2) {
                Ok(Some(t)) => {
                    if t.frame {
                        acquired += 1;
                        dirty = true;
                        frame_at = (t.wall_us as i64 * 10, t.at);
                        if exclusion.is_none() && start.elapsed() > Duration::from_millis(600) {
                            let (w, _, px) = cap_gpu.read_bgra(&dup.latest).map_err(|e| e.to_string())?;
                            let at = |x: i32, y: i32| {
                                let i = ((y - m.y) as usize * w as usize + (x - m.x) as usize) * 4;
                                (px[i + 2], px[i + 1], px[i])
                            };
                            let magenta = at(x0 + 760, y0 + 100);
                            let green = at(x0 + 760, y0 + 320);
                            println!("  pixel under the excluded window: rgb{magenta:?}; under the control: rgb{green:?}");
                            exclusion = Some((magenta == (255, 0, 255), green == (0, 255, 0)));
                        }
                    }
                }
                Ok(None) => {}
                Err(_) => return Err("lost the duplication mid-run".into()),
            }
            let due = last_feed.elapsed() >= interval;
            if dirty && due {
                let Some(slot) = encoder.slot() else {
                    skipped_pool += 1;
                    continue;
                };
                let time = frame_at.0.max(last_time + 1);
                last_time = time;
                captured.lock().unwrap().insert(time, frame_at.1);
                let src_tex = match &bridge {
                    Some(b) => {
                        let t = Instant::now();
                        b.carry(&cap_gpu, &gpu, &dup.latest).map_err(|e| format!("carry: {e}"))?;
                        carry_ms.push(t.elapsed().as_secs_f64() * 1000.0);
                        b.dst.clone()
                    }
                    None => dup.latest.clone(),
                };
                if rgb {
                    unsafe {
                        gpu.context.CopySubresourceRegion(&slot.texture, slot.index, 0, 0, 0, &src_tex, 0, None);
                        gpu.context.Flush();
                    }
                } else {
                    scaler.blt(&gpu, &src_tex, &slot.texture, slot.index).map_err(|e| format!("blt: {e}"))?;
                }
                let key = Instant::now() >= next_key;
                if key {
                    next_key += Duration::from_secs(2);
                    forced += 1;
                }
                encoder.submit(slot, time, 10_000_000 / a.fps as i64, key).map_err(|e| format!("submit: {e}"))?;
                fed += 1;
                dirty = false;
                last_feed = Instant::now();
            }
        }
        std::thread::sleep(Duration::from_millis(300));
        /* One frame alone, after a rest: does the encoder hand it back on its
           own, or only when the next frame pushes it out? The difference is a
           whole frame interval of latency, and under continuous feed the two
           look identical. */
        let before = out.lock().unwrap().frames;
        let mut lone = Vec::new();
        for _ in 0..3 {
            if let Some(slot) = encoder.slot() {
                let src_tex = bridge.as_ref().map(|b| b.dst.clone()).unwrap_or_else(|| dup.latest.clone());
                if rgb {
                    unsafe { gpu.context.CopySubresourceRegion(&slot.texture, slot.index, 0, 0, 0, &src_tex, 0, None) };
                } else {
                    let _ = scaler.blt(&gpu, &src_tex, &slot.texture, slot.index);
                }
                let t = wall_us() as i64 * 10;
                captured.lock().unwrap().insert(t, Instant::now());
                let fed = encoder.submit(slot, t, 10_000_000 / a.fps as i64, false);
                let n0 = out.lock().unwrap().frames;
                let t0 = Instant::now();
                while out.lock().unwrap().frames == n0 && t0.elapsed() < Duration::from_millis(400) {
                    std::thread::sleep(Duration::from_millis(1));
                }
                let got = out.lock().unwrap().frames > n0;
                lone.push(format!(
                    "{} {}",
                    if matches!(fed, Ok(encode::Fed::Now)) { "fed now" } else { "pending" },
                    if got { format!("→ out in {:.2} ms", t0.elapsed().as_secs_f64() * 1000.0) } else { "→ nothing within 400 ms".into() }
                ));
            }
        }
        println!("  lone frames after a rest ({} out before): {:?}", before, lone);
        drop(encoder);
        unsafe {
            let _ = DestroyWindow(scene);
            let _ = DestroyWindow(excluded);
            let _ = DestroyWindow(control);
        }
        pump();
        let _ = sink.lock().unwrap().flush();

        let mut o = out.lock().unwrap();
        let span = match (o.first_at, o.last_at) {
            (Some(a), Some(b)) if b > a => b.duration_since(a).as_secs_f64(),
            _ => a.secs as f64,
        };
        let mut l = o.latencies.clone();
        println!("  acquired {acquired} frames, fed {fed}, pool-empty skips {skipped_pool}, forced keys {forced}");
        println!(
            "  encoded {} frames in {:.2}s = {:.1} fps; {:.2} Mbit/s; keyframes {} ({} with SPS+PPS+IDR in-band); codec {}",
            o.frames,
            span,
            o.frames as f64 / span,
            o.bytes as f64 * 8.0 / span / 1e6,
            o.keys,
            o.keys_with_sets,
            o.codec.clone().unwrap_or_else(|| "?".into())
        );
        println!(
            "  capture→encoded latency: p50 {:.2} ms, p95 {:.2} ms, max {:.2} ms (n={})",
            pct(&mut l, 0.5),
            pct(&mut l, 0.95),
            l.last().copied().unwrap_or(f64::NAN),
            l.len()
        );
        if !carry_ms.is_empty() {
            println!("    carrying a frame across adapters: p50 {:.2} ms p95 {:.2}", pct(&mut carry_ms, 0.5), pct(&mut carry_ms, 0.95));
        }
        let (mut h, mut f) = (o.held.clone(), o.fed.clone());
        println!(
            "    of which: acquire→ProcessInput p50 {:.2} ms p95 {:.2}; inside the encoder p50 {:.2} ms p95 {:.2}",
            pct(&mut f, 0.5),
            pct(&mut f, 0.95),
            pct(&mut h, 0.5),
            pct(&mut h, 0.95)
        );
        match exclusion {
            Some((magenta_seen, green_seen)) => println!(
                "  exclusion: excluded window {} the capture; control window {} it",
                if magenta_seen { "IS IN" } else { "is absent from" },
                if green_seen { "is in" } else { "IS ABSENT FROM (control failed — the test proves nothing)" }
            ),
            None => println!("  exclusion: no frame arrived to test"),
        }
        println!("  wrote {}", file.display());
        match std::process::Command::new("ffprobe")
            .args(["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=codec_name,profile,width,height,nb_read_frames,color_space,color_range,pix_fmt", "-of", "compact"])
            .arg(&file)
            .output()
        {
            Ok(p) => println!("  ffprobe: {}{}", String::from_utf8_lossy(&p.stdout).trim(), String::from_utf8_lossy(&p.stderr).trim()),
            Err(_) => println!("  ffprobe: not on PATH, decode unchecked"),
        }
        Ok(())
    }
}
