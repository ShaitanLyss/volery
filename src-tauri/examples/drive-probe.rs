//! Whether this laptop can be driven *through its own tile* — a click on the
//! tile becoming a click on the real app under Volery, the keyboard reaching
//! that app, with Volery staying in front the whole time. Lyss chose that over
//! "step aside" on 2026-10-30, conditional on this probe (`docs/SCREENS.md`,
//! Decisions). It is the input lane's step 1.
//!
//! Windows has one cursor and one foreground window, and Volery covers the app
//! it would be driving. So the mechanism under test is: Volery `HWND_TOPMOST`,
//! made click-through for the instant of one injected click at the desktop
//! point under the tile's point, the app it lands on becoming the foreground
//! window (so the physical keyboard reaches it natively), Volery still drawn on
//! top because it is topmost. Each half is a separate question here:
//!
//! - **flash**: does toggling the click-through on a WebView2-hosting window —
//!   `WS_EX_TRANSPARENT`, `WS_EX_LAYERED`, or a `SetWindowRgn` hole — show a
//!   blank or stale frame? Sampled every composition frame (`DwmFlush`, then a
//!   `BitBlt` of the composed desktop) against a control run of the same length.
//! - **hit test**: under each, does `WindowFromPoint` see the app below?
//! - **click / keys / wheel / drag**: do they land, measured in a page that
//!   writes what it received into its own title, and in a classic Win32 EDIT
//!   control this probe makes itself (Notepad is single-instance with tabs on
//!   Windows 11, so launching one would move Lyss's own window).
//! - **activation**: a click on the tile activates Volery and blurs the app.
//! - **occlusion**: Chromium (and so Edge, Chrome, every Electron app) stops
//!   painting a window it thinks is covered. Covered by Volery is exactly the
//!   state a through-the-tile app is in, so its rAF rate is measured under
//!   each candidate style.
//!
//! ## What it measured (2026-10-31, lab `drive`, WebView2 156, Edge 156, 240 Hz panel at 150%)
//!
//! - **No flash.** Toggling `WS_EX_TRANSPARENT`, `WS_EX_LAYERED|WS_EX_TRANSPARENT`
//!   (+ `SetLayeredWindowAttributes(255)`), a `SetWindowRgn` hole, or topmost,
//!   twenty times each: no composed frame of the lab changed by more than the
//!   control (max 0.000 against a 0.000 control; 0.033 during real clicks, which
//!   is the lab's own hover). The calls take 2.1, 3.7, 7.2 ms.
//! - **Hit test.** `WS_EX_TRANSPARENT` alone does *not* let a click through
//!   (the lab still owns the point); layered+transparent and the region hole do.
//! - **Click through the tile: 8/8** with layered+transparent — the page counted
//!   every click, Edge became the foreground window every time, the lab stayed
//!   above it every time. Region hole 7/8. Click-through held 32–83 ms (median
//!   39), the cursor away from the tile 16–46 ms (median 24) — a visible blink
//!   at 240 Hz, cosmetic.
//! - **Keys** reach the app natively once it is foreground: `hello` + Enter in
//!   the page, the same in a Win32 EDIT control. `SetForegroundWindow` from the
//!   lab's foreground (attached input) also hands it over, lab still on top.
//!   On AZERTY the scancode under US `A` is `Q`, so a probe's Ctrl+"A" is Ctrl+Q.
//! - **Activation.** Each physical click on the tile activates Volery and blurs
//!   the app (7 blurs in 8); the injected click gives it straight back.
//! - **Occlusion — the finding that matters.** A Chromium window (Edge, Chrome,
//!   every Electron app) under the topmost lab is marked hidden and paints
//!   nothing: 0 rAF/s, `visibilityState` hidden — the tile would show a frozen
//!   page while you type into it. Recomputed after each style (`visible`):
//!   as it is 0; `WS_EX_TRANSPARENT` alone **240**; layered alpha 255 0; layered
//!   alpha 254 239; a 5px region hole 239; `WS_EX_TOOLWINDOW` 240; every control
//!   between them 0. So Volery wears `WS_EX_TRANSPARENT` while driving its own
//!   tile: Chromium stops counting it as a cover, and alone it is not
//!   click-through. Whether `WDA_EXCLUDEFROMCAPTURE` changes this is not
//!   answered: a plain topmost popup of the probe's own read visible too.
//! - **Wheel** with no cursor at all: `SendMessage(WM_MOUSEWHEEL)` to the window
//!   under the point, with the lab let through for the 1.6–3.4 ms it takes,
//!   scrolled 100 px a notch. With the lab in the way it scrolls nothing —
//!   Chromium routes a wheel to the window under the message's point.
//! - **Drag-select** works with click-through held for the drag (~465 ms of
//!   cursor away from the tile).
//!
//! Not measured from outside the process: `MA_NOACTIVATE` for a tile click
//! (needs Volery's own window procedure), and a driven app's popup menus,
//! which are topmost and may open over Volery on the real desktop.
//!
//! Runs against a **lab** wall only — it finds the window by its process image
//! living under `dev.skein.lab.<name>`, never the installed wall's.
//!
//! ```text
//! cargo run --example drive-probe -- find <lab>          # windows, styles, a screenshot; no input
//! cargo run --example drive-probe -- run <lab> [tx ty]   # everything; MOVES THE REAL CURSOR
//! cargo run --example drive-probe -- visible <lab>       # which style of Volery's stops Chromium
//!                                                        # painting under it; the wheel by message.
//!                                                        # Moves windows, no input at all
//! cargo run --example drive-probe -- drive <lab>         # `cast::drive` itself, end to end: clicks,
//!                                                        # keys, wheel, drag. Never Escape — see STAGE
//! cargo run --example drive-probe -- hits <lab>          # what the tile's point hit-tests as while a
//!                                                        # drive is on; no input at all
//! ```
//!
//! `run` moves windows, the cursor and clicks for about forty seconds. Ask the
//! person at the machine first. A physical Escape between steps aborts and puts
//! everything back.

#[cfg(not(windows))]
fn main() {
    eprintln!("drive-probe is Windows-only");
}

#[cfg(windows)]
fn main() {
    win::main()
}

#[cfg(windows)]
mod win {
    use std::path::{Path, PathBuf};
    use std::process::{Child, Command};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc};
    use std::thread;
    use std::time::{Duration, Instant};

    use windows::core::{w, BOOL, PCWSTR, PWSTR};
    use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
    use windows::Win32::Graphics::Dwm::DwmFlush;
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CombineRgn, CreateCompatibleBitmap, CreateCompatibleDC, CreateRectRgn,
        DeleteDC, DeleteObject, GetDC, GetDIBits, ReleaseDC, SelectObject, SetWindowRgn, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ, RGN_DIFF, SRCCOPY,
    };
    use windows::Win32::System::Threading::{
        AttachThreadInput, GetCurrentThreadId, OpenProcess, QueryFullProcessImageNameW,
        PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::HiDpi::{
        GetDpiForWindow, SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT,
        KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE, MOUSEEVENTF_ABSOLUTE,
        MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_VIRTUALDESK,
        MOUSEEVENTF_WHEEL, MOUSEINPUT, MOUSE_EVENT_FLAGS, VIRTUAL_KEY, VK_ESCAPE, VK_LBUTTON,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, EnumChildWindows, EnumWindows,
        GetAncestor, GetClassNameW, GetCursorPos, GetForegroundWindow, GetMessageW,
        GetSystemMetrics, GetWindow, GetWindowLongPtrW, GetWindowRect, GetWindowTextW,
        GetWindowThreadProcessId, IsWindowVisible, PostMessageW, PostQuitMessage,
        RegisterClassW, SendMessageW, SetCursorPos, SetForegroundWindow,
        SetLayeredWindowAttributes, SetWindowLongPtrW, SetWindowPos,
        TranslateMessage, ES_AUTOHSCROLL, GA_ROOT, GWL_EXSTYLE, GW_HWNDNEXT, HWND_NOTOPMOST,
        HWND_TOPMOST, LWA_ALPHA, MSG, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN,
        SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
        SWP_NOZORDER, WINDOW_EX_STYLE, WINDOW_STYLE, WM_CLOSE, WM_DESTROY, WM_GETTEXT,
        WM_MOUSEWHEEL, WNDCLASSW, WS_BORDER, WS_CHILD, WS_EX_LAYERED, WS_EX_NOREDIRECTIONBITMAP,
        WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_OVERLAPPEDWINDOW, WS_VISIBLE,
    };

    /* ── small Win32 helpers ───────────────────────────────────────────── */

    fn text_of(h: HWND) -> String {
        let mut buf = [0u16; 512];
        let n = unsafe { GetWindowTextW(h, &mut buf) };
        String::from_utf16_lossy(&buf[..n.max(0) as usize])
    }

    fn class_of(h: HWND) -> String {
        let mut buf = [0u16; 256];
        let n = unsafe { GetClassNameW(h, &mut buf) };
        String::from_utf16_lossy(&buf[..n.max(0) as usize])
    }

    fn pid_of(h: HWND) -> u32 {
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(h, Some(&mut pid)) };
        pid
    }

    fn image_of(pid: u32) -> String {
        unsafe {
            let Ok(p) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                return String::new();
            };
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(p, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len);
            let _ = windows::Win32::Foundation::CloseHandle(p);
            if ok.is_err() {
                return String::new();
            }
            String::from_utf16_lossy(&buf[..len as usize])
        }
    }

    fn rect_of(h: HWND) -> RECT {
        let mut r = RECT::default();
        unsafe {
            let _ = GetWindowRect(h, &mut r);
        }
        r
    }

    fn exstyle(h: HWND) -> u32 {
        unsafe { GetWindowLongPtrW(h, GWL_EXSTYLE) as u32 }
    }

    fn set_exstyle(h: HWND, v: u32) {
        unsafe {
            SetWindowLongPtrW(h, GWL_EXSTYLE, v as isize);
        }
    }

    fn top_levels() -> Vec<HWND> {
        unsafe extern "system" fn cb(h: HWND, l: LPARAM) -> BOOL {
            let v = &mut *(l.0 as *mut Vec<HWND>);
            v.push(h);
            BOOL(1)
        }
        let mut v: Vec<HWND> = Vec::new();
        unsafe {
            let _ = EnumWindows(Some(cb), LPARAM(&mut v as *mut _ as isize));
        }
        v
    }

    fn children(h: HWND) -> Vec<HWND> {
        unsafe extern "system" fn cb(h: HWND, l: LPARAM) -> BOOL {
            let v = &mut *(l.0 as *mut Vec<HWND>);
            v.push(h);
            BOOL(1)
        }
        let mut v: Vec<HWND> = Vec::new();
        unsafe {
            let _ = EnumChildWindows(Some(h), Some(cb), LPARAM(&mut v as *mut _ as isize));
        }
        v
    }

    fn cursor() -> (i32, i32) {
        let mut p = POINT::default();
        unsafe {
            let _ = GetCursorPos(&mut p);
        }
        (p.x, p.y)
    }

    fn escape_pressed() -> bool {
        unsafe { (GetAsyncKeyState(VK_ESCAPE.0 as i32) as u16 & 0x8000) != 0 }
    }

    fn ms(d: Duration) -> f64 {
        d.as_secs_f64() * 1000.0
    }

    /* ── finding the lab ───────────────────────────────────────────────── */

    fn find_lab(name: &str) -> Option<HWND> {
        let needle = format!("dev.skein.lab.{}\\", name.to_ascii_lowercase());
        top_levels().into_iter().find(|&h| {
            (unsafe { IsWindowVisible(h).as_bool() })
                && text_of(h) == "Volery"
                && image_of(pid_of(h)).to_ascii_lowercase().contains(&needle)
        })
    }

    fn describe(h: HWND) {
        let r = rect_of(h);
        let ex = exstyle(h);
        println!(
            "  {:?} class={} pid={} rect=({},{})-({},{}) ex=0x{:08x}{}{}{}{} dpi={}",
            h.0,
            class_of(h),
            pid_of(h),
            r.left,
            r.top,
            r.right,
            r.bottom,
            ex,
            if ex & WS_EX_LAYERED.0 != 0 { " LAYERED" } else { "" },
            if ex & WS_EX_TRANSPARENT.0 != 0 { " TRANSPARENT" } else { "" },
            if ex & WS_EX_NOREDIRECTIONBITMAP.0 != 0 { " NOREDIRECTIONBITMAP" } else { "" },
            if ex & WS_EX_TOPMOST.0 != 0 { " TOPMOST" } else { "" },
            unsafe { GetDpiForWindow(h) },
        );
    }

    /* ── seeing the screen ─────────────────────────────────────────────── */

    /// The composed desktop over one rectangle, as BGRA rows.
    struct Grab {
        w: i32,
        h: i32,
        px: Vec<u8>,
    }

    fn grab(r: RECT) -> Grab {
        let (w, h) = (r.right - r.left, r.bottom - r.top);
        let mut px = vec![0u8; (w * h * 4) as usize];
        unsafe {
            let screen = GetDC(None);
            let mem = CreateCompatibleDC(Some(screen));
            let bmp = CreateCompatibleBitmap(screen, w, h);
            let old = SelectObject(mem, HGDIOBJ(bmp.0));
            let _ = BitBlt(mem, 0, 0, w, h, Some(screen), r.left, r.top, SRCCOPY);
            let mut bi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: w,
                    biHeight: -h,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            GetDIBits(mem, bmp, 0, h as u32, Some(px.as_mut_ptr() as *mut _), &mut bi, DIB_RGB_COLORS);
            SelectObject(mem, old);
            let _ = DeleteObject(HGDIOBJ(bmp.0));
            let _ = DeleteDC(mem);
            ReleaseDC(None, screen);
        }
        Grab { w, h, px }
    }

    /// Share of sampled pixels that moved more than a little from `base`. A
    /// blank or black frame scores near 1; the backdrop's drifting leaves score
    /// a few percent, which is what the control run is for.
    fn changed(base: &Grab, now: &Grab) -> f64 {
        let (mut n, mut moved) = (0u32, 0u32);
        let mut y = 0;
        while y < base.h.min(now.h) {
            let mut x = 0;
            while x < base.w.min(now.w) {
                let i = ((y * base.w + x) * 4) as usize;
                let d: i32 = (0..3).map(|k| (base.px[i + k] as i32 - now.px[i + k] as i32).abs()).sum();
                n += 1;
                if d > 48 {
                    moved += 1;
                }
                x += 8;
            }
            y += 8;
        }
        moved as f64 / n.max(1) as f64
    }

    fn save_bmp(g: &Grab, path: &Path) {
        let row = (g.w * 4) as u32;
        let size = 54 + row * g.h as u32;
        let mut f = Vec::with_capacity(size as usize);
        f.extend_from_slice(b"BM");
        f.extend_from_slice(&size.to_le_bytes());
        f.extend_from_slice(&[0; 4]);
        f.extend_from_slice(&54u32.to_le_bytes());
        f.extend_from_slice(&40u32.to_le_bytes());
        f.extend_from_slice(&g.w.to_le_bytes());
        f.extend_from_slice(&(-g.h).to_le_bytes());
        f.extend_from_slice(&1u16.to_le_bytes());
        f.extend_from_slice(&32u16.to_le_bytes());
        f.extend_from_slice(&[0; 24]);
        f.extend_from_slice(&g.px);
        std::fs::write(path, f).expect("write bmp");
    }

    /// A thread grabbing every composition frame and scoring it against the
    /// first, until stopped. Returns every score.
    struct Sampler {
        stop: Arc<AtomicBool>,
        out: thread::JoinHandle<Vec<f64>>,
    }

    fn sample(r: RECT) -> Sampler {
        let stop = Arc::new(AtomicBool::new(false));
        let s = stop.clone();
        let out = thread::spawn(move || {
            unsafe {
                let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            }
            let _ = unsafe { DwmFlush() };
            let base = grab(r);
            let mut v = Vec::new();
            while !s.load(Ordering::Relaxed) {
                let _ = unsafe { DwmFlush() };
                v.push(changed(&base, &grab(r)));
            }
            v
        });
        Sampler { stop, out }
    }

    impl Sampler {
        fn finish(self) -> Vec<f64> {
            self.stop.store(true, Ordering::Relaxed);
            self.out.join().unwrap()
        }
    }

    fn summary(v: &[f64]) -> String {
        let max = v.iter().cloned().fold(0.0, f64::max);
        let big = v.iter().filter(|&&x| x > 0.25).count();
        let mean = v.iter().sum::<f64>() / v.len().max(1) as f64;
        format!("{} frames, mean {:.3}, max {:.3}, frames >25% changed: {}", v.len(), mean, max, big)
    }

    /* ── input ─────────────────────────────────────────────────────────── */

    /* Every injected event is aimed, and the aim is checked first.

       A run on 2026-10-31 had the test Edge open *behind* Lyss's installed
       wall instead of in front of it, and every "click through the lab" landed
       on the installed wall; the keys typed a `hello` and an Enter into her
       composer, which sent it to the card running this probe, and an Escape
       stopped that card. Nothing checked where an event would land. So the
       stage registers its own windows, every click and keystroke is refused
       unless it would reach one of them, and a refusal ends the run (the
       panic unwinds through `Restore`, which puts everything back). Escape is
       no longer sent at all. */
    static STAGE: std::sync::Mutex<Vec<isize>> = std::sync::Mutex::new(Vec::new());

    fn stage(windows: &[HWND]) {
        let mut st = STAGE.lock().unwrap();
        st.clear();
        st.extend(windows.iter().map(|h| h.0 as isize));
    }

    fn staged(h: HWND) -> bool {
        STAGE.lock().unwrap().contains(&(h.0 as isize))
    }

    /// A press at `p` straight onto the screen must land on a stage window.
    fn aim_direct(p: (i32, i32)) {
        let r = root_at(p.0, p.1);
        if !staged(r) {
            // say what the screen looked like, so a refusal is a finding
            let lab = HWND(STAGE.lock().unwrap()[0] as *mut _);
            let lr = rect_of(lab);
            println!(
                "  REFUSED at {p:?}. lab ex=0x{:08x} rect=({},{})-({},{}) visible={}",
                exstyle(lab),
                lr.left,
                lr.top,
                lr.right,
                lr.bottom,
                unsafe { IsWindowVisible(lab).as_bool() }
            );
            println!("  windows holding that point, top to bottom:");
            for h in top_levels() {
                let w = rect_of(h);
                if unsafe { IsWindowVisible(h).as_bool() } && p.0 >= w.left && p.0 < w.right && p.1 >= w.top && p.1 < w.bottom {
                    println!(
                        "    {:?} '{}' ({}) ex=0x{:08x}{}",
                        h.0,
                        text_of(h),
                        class_of(h),
                        exstyle(h),
                        if h == lab { "  <- the lab" } else { "" }
                    );
                    if h == lab {
                        break;
                    }
                }
            }
            panic!("refusing to click at {p:?}: it would land on '{}' ({}), not the test's own windows", text_of(r), class_of(r));
        }
    }

    /// A press through the lab at `p` must land on a stage window under it.
    fn aim_through(lab: HWND, p: (i32, i32)) {
        let r = root_at_below(lab, p);
        if r == lab || !staged(r) {
            println!("  REFUSED through the lab at {p:?}. the z-order from the top, visible windows holding the point:");
            for h in top_levels() {
                let w = rect_of(h);
                if unsafe { IsWindowVisible(h).as_bool() } && p.0 >= w.left && p.0 < w.right && p.1 >= w.top && p.1 < w.bottom {
                    println!(
                        "    {:?} '{}' ({}) ex=0x{:08x}{}{}",
                        h.0,
                        text_of(h),
                        class_of(h),
                        exstyle(h),
                        if h == lab { "  <- the lab" } else { "" },
                        if staged(h) && h != lab { "  <- staged" } else { "" }
                    );
                }
            }
            println!("  foreground: '{}' ({})", text_of(unsafe { GetForegroundWindow() }), class_of(unsafe { GetForegroundWindow() }));
            panic!(
                "refusing to click through the lab at {p:?}: under it is '{}' ({}), not the test's own windows",
                text_of(r),
                class_of(r)
            );
        }
    }

    /// Keys go to the foreground window, so it must be a stage window — and
    /// never the lab, which is a Volery and would take them as a prompt.
    fn aim_keys(lab: HWND) {
        let f = unsafe { GetForegroundWindow() };
        if f == lab || !staged(f) {
            panic!("refusing to type: the foreground is '{}' ({}), not the test's own page", text_of(f), class_of(f));
        }
    }

    fn mouse(flags: MOUSE_EVENT_FLAGS, dx: i32, dy: i32, data: i32) -> INPUT {
        INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT { dx, dy, mouseData: data as u32, dwFlags: flags, time: 0, dwExtraInfo: 0 },
            },
        }
    }

    /// A desktop pixel → `SendInput`'s 0..65535 over the virtual desktop. The
    /// rounding is the one that lands on the pixel asked for rather than the
    /// one before it: Windows maps back with a floor.
    fn abs(x: i32, y: i32) -> (i32, i32) {
        let (vx, vy, vw, vh) = unsafe {
            (
                GetSystemMetrics(SM_XVIRTUALSCREEN),
                GetSystemMetrics(SM_YVIRTUALSCREEN),
                GetSystemMetrics(SM_CXVIRTUALSCREEN),
                GetSystemMetrics(SM_CYVIRTUALSCREEN),
            )
        };
        (
            (((x - vx) as i64 * 65536 + vw as i64 - 1) / vw as i64) as i32,
            (((y - vy) as i64 * 65536 + vh as i64 - 1) / vh as i64) as i32,
        )
    }

    fn move_to(x: i32, y: i32) -> INPUT {
        let (ax, ay) = abs(x, y);
        mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, ax, ay, 0)
    }

    fn send(v: &[INPUT]) {
        unsafe { SendInput(v, std::mem::size_of::<INPUT>() as i32) };
    }

    /// What a physical click on the tile is: the press lands on Volery.
    fn click_at(x: i32, y: i32) {
        aim_direct((x, y));
        send(&[move_to(x, y), mouse(MOUSEEVENTF_LEFTDOWN, 0, 0, 0), mouse(MOUSEEVENTF_LEFTUP, 0, 0, 0)]);
    }

    fn key(scan: u16, up: bool) -> INPUT {
        let mut flags = KEYEVENTF_SCANCODE;
        if up {
            flags |= KEYEVENTF_KEYUP;
        }
        if scan & 0xff00 == 0xe000 {
            flags |= KEYBD_EVENT_FLAGS(0x0001); // KEYEVENTF_EXTENDEDKEY
        }
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT { wVk: VIRTUAL_KEY(0), wScan: scan & 0xff, dwFlags: flags, time: 0, dwExtraInfo: 0 },
            },
        }
    }

    /// Scancodes stand in for the physical keyboard: injected key input goes to
    /// the foreground window exactly as a real key does.
    fn type_scans(scans: &[u16]) {
        for &s in scans {
            send(&[key(s, false), key(s, true)]);
            thread::sleep(Duration::from_millis(8));
        }
    }

    const SCAN_H: u16 = 0x23;
    const SCAN_E: u16 = 0x12;
    const SCAN_L: u16 = 0x26;
    const SCAN_O: u16 = 0x18;
    const SCAN_X: u16 = 0x2d;
    const SCAN_Y: u16 = 0x15;
    const SCAN_ENTER: u16 = 0x1c;
    const SCAN_CTRL: u16 = 0x1d;
    const SCAN_A_POS: u16 = 0x1e; // the key, whatever the layout calls it

    /* ── the ways to let a click through ───────────────────────────────── */

    #[derive(Clone, Copy, Debug, PartialEq)]
    enum Through {
        Transparent,
        LayeredTransparent,
        RegionHole,
    }

    fn through_on(h: HWND, how: Through, at: (i32, i32), base_ex: u32) {
        match how {
            Through::Transparent => set_exstyle(h, base_ex | WS_EX_TRANSPARENT.0),
            Through::LayeredTransparent => {
                set_exstyle(h, base_ex | WS_EX_TRANSPARENT.0 | WS_EX_LAYERED.0);
                if base_ex & WS_EX_LAYERED.0 == 0 {
                    unsafe {
                        let _ = SetLayeredWindowAttributes(h, COLORREF(0), 255, LWA_ALPHA);
                    }
                }
            }
            Through::RegionHole => unsafe {
                let r = rect_of(h);
                let (x, y) = (at.0 - r.left, at.1 - r.top);
                let all = CreateRectRgn(0, 0, r.right - r.left, r.bottom - r.top);
                let hole = CreateRectRgn(x - 2, y - 2, x + 3, y + 3);
                CombineRgn(Some(all), Some(all), Some(hole), RGN_DIFF);
                let _ = DeleteObject(HGDIOBJ(hole.0));
                SetWindowRgn(h, Some(all), false);
            },
        }
    }

    fn through_off(h: HWND, how: Through, base_ex: u32) {
        match how {
            Through::Transparent | Through::LayeredTransparent => set_exstyle(h, base_ex),
            Through::RegionHole => unsafe {
                SetWindowRgn(h, None, false);
            },
        }
    }

    /// The whole of one through-the-tile click: let clicks through, a batch of
    /// [move to P, down, up, move back to T] — one batch, so the raw input
    /// thread presses at P whatever the timing — wait until the cursor is back
    /// at T (which proves the press has been hit-tested), close up again.
    /// Returns (time click-through was on, time the cursor was away).
    fn drive_click(lab: HWND, how: Through, p: (i32, i32), t: (i32, i32), base_ex: u32) -> (Duration, Duration) {
        aim_through(lab, p);
        let start = Instant::now();
        through_on(lab, how, p, base_ex);
        let sent = Instant::now();
        send(&[
            move_to(p.0, p.1),
            mouse(MOUSEEVENTF_LEFTDOWN, 0, 0, 0),
            mouse(MOUSEEVENTF_LEFTUP, 0, 0, 0),
            move_to(t.0, t.1),
        ]);
        let deadline = Instant::now() + Duration::from_millis(300);
        loop {
            let c = cursor();
            if ((c.0 - t.0).abs() <= 1 && (c.1 - t.1).abs() <= 1) || Instant::now() > deadline {
                break;
            }
            std::hint::spin_loop();
        }
        let back = sent.elapsed();
        through_off(lab, how, base_ex);
        (start.elapsed(), back)
    }

    fn root_at(x: i32, y: i32) -> HWND {
        unsafe {
            let h = windows::Win32::UI::WindowsAndMessaging::WindowFromPoint(POINT { x, y });
            GetAncestor(h, GA_ROOT)
        }
    }

    /// Whether `upper` is above `lower` in the z-order.
    fn above(upper: HWND, lower: HWND) -> bool {
        let mut h = upper;
        for _ in 0..2000 {
            match unsafe { GetWindow(h, GW_HWNDNEXT) } {
                Ok(n) if !n.is_invalid() => {
                    if n == lower {
                        return true;
                    }
                    h = n;
                }
                _ => return false,
            }
        }
        false
    }

    fn place(h: HWND, after: Option<HWND>, x: i32, y: i32, w: i32, hh: i32) {
        unsafe {
            let flags = if after.is_none() { SWP_NOZORDER | SWP_NOACTIVATE } else { SWP_NOACTIVATE };
            let _ = SetWindowPos(h, after, x, y, w, hh, flags);
        }
    }

    /// Put a test window at the top of the ordinary windows — above anything
    /// of Lyss's — without leaving it topmost. Left topmost, the first click
    /// that activated it lifted it *above* the lab (two topmost windows
    /// reorder on activation), which no driven app can do; the guard caught it.
    fn raise_under_lab(h: HWND) {
        zorder(h, HWND_TOPMOST);
        zorder(h, HWND_NOTOPMOST);
    }

    fn zorder(h: HWND, after: HWND) {
        unsafe {
            let _ = SetWindowPos(h, Some(after), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }
    }

    /* ── the page and the edit control under test ──────────────────────── */

    const PAGE: &str = r#"<!doctype html><meta charset=utf-8><title>dp</title>
<style>body{margin:0;font:20px sans-serif;background:#dde}#b{position:absolute;left:20px;top:20px;width:200px;height:80px;font-size:20px}#t{position:absolute;left:20px;top:120px;width:320px;height:40px;font-size:20px}#long{height:6000px}</style>
<button id=b>click</button><input id=t value="select me please"><div id=long></div>
<script>
let c=0,bl=0,fo=0,e='',r=0,md=0,k='';
b.onclick=()=>{c++;show()};addEventListener('mousedown',()=>{md++});
addEventListener('blur',()=>{bl++;show()});addEventListener('focus',()=>{fo++;show()});addEventListener('keydown',ev=>{k=ev.key;show()},true);
t.addEventListener('keydown',ev=>{if(ev.key==='Enter'){e=t.value;show()}});
t.addEventListener('input',show);addEventListener('scroll',show);
document.addEventListener('selectionchange',show);document.addEventListener('visibilitychange',show);
(function f(){r++;requestAnimationFrame(f)})();
function show(){document.title=`dp|c=${c}|b=${bl}|f=${fo}|y=${Math.round(scrollY)}|e=${e}|v=${t.value}|s=${t.selectionStart}-${t.selectionEnd}|vis=${document.visibilityState[0]}|r=${r}|md=${md}|k=${k}`}
setInterval(show,50);show();
</script>"#;

    #[derive(Debug, Default, Clone)]
    struct Page {
        c: u32,
        b: u32,
        y: i64,
        e: String,
        v: String,
        s: String,
        vis: String,
        r: u64,
    }

    fn page_of(h: HWND) -> Option<Page> {
        let t = text_of(h);
        if !t.starts_with("dp|") {
            return None;
        }
        let mut p = Page::default();
        for kv in t.split('|').skip(1) {
            let (k, v) = kv.split_once('=')?;
            match k {
                "c" => p.c = v.parse().ok()?,
                "b" => p.b = v.parse().ok()?,
                "y" => p.y = v.parse().ok()?,
                "e" => p.e = v.into(),
                "v" => p.v = v.into(),
                "s" => p.s = v.into(),
                "vis" => p.vis = v.into(),
                "r" => p.r = v.parse().ok()?,
                _ => {}
            }
        }
        Some(p)
    }

    fn settle_page(h: HWND) -> Page {
        thread::sleep(Duration::from_millis(250));
        page_of(h).unwrap_or_default()
    }

    /// rAF callbacks a second, and what the page says its visibility is.
    fn frame_rate(h: HWND) -> (f64, String) {
        let a = page_of(h).unwrap_or_default();
        let t = Instant::now();
        thread::sleep(Duration::from_millis(1000));
        let b = page_of(h).unwrap_or_default();
        ((b.r.saturating_sub(a.r)) as f64 / t.elapsed().as_secs_f64(), b.vis)
    }

    fn launch_edge(dir: &Path, x: i32, y: i32, w: i32, h: i32) -> (Child, HWND) {
        let page = dir.join("page.html");
        std::fs::write(&page, PAGE).unwrap();
        let profile = dir.join("edge-profile");
        let url = format!("file:///{}", page.display().to_string().replace('\\', "/"));
        let child = Command::new(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
            .arg(format!("--user-data-dir={}", profile.display()))
            .args(["--no-first-run", "--no-default-browser-check", "--disable-sync"])
            .arg(format!("--app={url}"))
            .arg(format!("--window-position={x},{y}"))
            .arg(format!("--window-size={w},{h}"))
            .spawn()
            .expect("launch edge");
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            if let Some(h) = top_levels()
                .into_iter()
                .find(|&h| unsafe { IsWindowVisible(h).as_bool() } && text_of(h).starts_with("dp|"))
            {
                return (child, h);
            }
            if Instant::now() > deadline {
                let mut child = child;
                let _ = child.kill();
                panic!("edge never showed the page");
            }
            thread::sleep(Duration::from_millis(100));
        }
    }

    /// Where the page's own pixels start: the render widget's top-left.
    fn page_origin(edge: HWND) -> (i32, i32, f64) {
        let scale = unsafe { GetDpiForWindow(edge) } as f64 / 96.0;
        for c in children(edge) {
            if class_of(c) == "Chrome_RenderWidgetHostHWND" {
                let r = rect_of(c);
                return (r.left, r.top, scale);
            }
        }
        let r = rect_of(edge);
        (r.left + (8.0 * scale) as i32, r.top + (40.0 * scale) as i32, scale)
    }

    unsafe extern "system" fn edit_proc(h: HWND, m: u32, w: WPARAM, l: LPARAM) -> LRESULT {
        if m == WM_DESTROY {
            PostQuitMessage(0);
            return LRESULT(0);
        }
        DefWindowProcW(h, m, w, l)
    }

    /// A classic Win32 window with an EDIT control in it, on a thread with a
    /// message loop of its own. Returns (frame, edit) as raw handles.
    fn edit_window(x: i32, y: i32, w: i32, h: i32) -> (isize, isize) {
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || unsafe {
            let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            let inst = windows::Win32::System::LibraryLoader::GetModuleHandleW(None).unwrap();
            let wc = WNDCLASSW {
                lpfnWndProc: Some(edit_proc),
                hInstance: inst.into(),
                lpszClassName: w!("DriveProbeEdit"),
                ..Default::default()
            };
            RegisterClassW(&wc);
            let frame = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("DriveProbeEdit"),
                w!("drive-probe edit"),
                WS_OVERLAPPEDWINDOW | WS_VISIBLE,
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
            let edit = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("EDIT"),
                PCWSTR::null(),
                WS_CHILD | WS_VISIBLE | WS_BORDER | WINDOW_STYLE(ES_AUTOHSCROLL as u32),
                10,
                10,
                w - 40,
                40,
                Some(frame),
                None,
                Some(inst.into()),
                None,
            )
            .unwrap();
            tx.send((frame.0 as isize, edit.0 as isize)).unwrap();
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        });
        rx.recv().unwrap()
    }

    fn edit_text(edit: HWND) -> String {
        let mut buf = [0u16; 256];
        let n = unsafe { SendMessageW(edit, WM_GETTEXT, Some(WPARAM(buf.len())), Some(LPARAM(buf.as_mut_ptr() as isize))) };
        String::from_utf16_lossy(&buf[..n.0.max(0) as usize])
    }

    /* ── putting it all back ───────────────────────────────────────────── */

    struct Restore {
        lab: HWND,
        ex: u32,
        rect: RECT,
        cursor: (i32, i32),
        edge: Option<(Child, HWND)>,
        edit_frame: Option<HWND>,
    }

    impl Drop for Restore {
        fn drop(&mut self) {
            unsafe {
                if (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 0x8000) != 0 {
                    send(&[mouse(MOUSEEVENTF_LEFTUP, 0, 0, 0)]);
                }
                set_exstyle(self.lab, self.ex);
                SetWindowRgn(self.lab, None, true);
                let _ = SetWindowPos(self.lab, Some(HWND_NOTOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
                let r = self.rect;
                place(self.lab, None, r.left, r.top, r.right - r.left, r.bottom - r.top);
                let _ = SetCursorPos(self.cursor.0, self.cursor.1);
                if let Some((mut child, h)) = self.edge.take() {
                    let _ = PostMessageW(Some(h), WM_CLOSE, WPARAM(0), LPARAM(0));
                    thread::sleep(Duration::from_millis(500));
                    let _ = child.kill();
                }
                if let Some(f) = self.edit_frame {
                    let _ = PostMessageW(Some(f), WM_CLOSE, WPARAM(0), LPARAM(0));
                }
            }
            println!("restored: lab style, region, z-order and place; cursor; edge and the edit window closed");
        }
    }

    macro_rules! bail_on_escape {
        () => {
            if escape_pressed() {
                println!("ESCAPE — aborting");
                return;
            }
        };
    }

    /* ── main ──────────────────────────────────────────────────────────── */

    pub fn main() {
        unsafe {
            let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        }
        let args: Vec<String> = std::env::args().skip(1).collect();
        let (mode, name) = match (args.first(), args.get(1)) {
            (Some(m), Some(n)) => (m.as_str(), n.as_str()),
            _ => {
                eprintln!("usage: drive-probe find|run <lab> [tx ty]");
                std::process::exit(2);
            }
        };
        let Some(lab) = find_lab(name) else {
            eprintln!("no visible lab window for dev.skein.lab.{name}");
            std::process::exit(1);
        };
        let dir = PathBuf::from(std::env::var("DRIVE_PROBE_DIR").unwrap_or_else(|_| ".".into()));
        std::fs::create_dir_all(&dir).unwrap();
        // Edge is handed a file URL, which wants an absolute path without `\\?\`
        let dir = PathBuf::from(
            dir.canonicalize().unwrap().display().to_string().trim_start_matches(r"\\?\").to_string(),
        );
        println!("lab window:");
        describe(lab);
        println!("its children:");
        for c in children(lab) {
            describe(c);
            println!("    image {}", image_of(pid_of(c)));
        }
        match mode {
            "find" => {
                let g = grab(rect_of(lab));
                let p = dir.join("lab.bmp");
                save_bmp(&g, &p);
                println!("screenshot: {}", p.display());
            }
            "run" => run(lab, &dir, &args[2..]),
            "visible" => visible(lab, &dir),
            "drive" => drive(lab, &dir),
            "hits" => hits(lab, &dir, args.get(2).and_then(|v| v.parse().ok()).unwrap_or(4000)),
            _ => eprintln!("unknown mode {mode}"),
        }
    }

    fn run(lab: HWND, dir: &Path, rest: &[String]) {
        let base_ex = exstyle(lab);
        let mut guard = Restore { lab, ex: base_ex, rect: rect_of(lab), cursor: cursor(), edge: None, edit_frame: None };

        /* The stage: the lab at L, Edge and the edit window inside it, under it. */
        let (lx, ly, lw, lh) = (200, 120, 1300, 800);
        place(lab, None, lx, ly, lw, lh);
        let (edge_child, edge) = launch_edge(dir, lx + 60, ly + 60, 800, 600);
        guard.edge = Some((edge_child, edge));
        place(edge, None, lx + 60, ly + 60, 800, 600);
        let (ef, ee) = edit_window(lx + 900, ly + 120, 360, 160);
        let (edit_frame, edit) = (HWND(ef as *mut _), HWND(ee as *mut _));
        guard.edit_frame = Some(edit_frame);
        thread::sleep(Duration::from_millis(1500));
        stage(&[lab, edge, edit_frame]);
        raise_under_lab(edge);
        raise_under_lab(edit_frame);
        // HWND_TOP is refused across processes; topmost is what driving uses anyway
        zorder(lab, HWND_TOPMOST);
        thread::sleep(Duration::from_millis(300));
        println!("\nstage: lab {:?}, edge {:?}, edit {:?}", rect_of(lab), rect_of(edge), rect_of(edit_frame));
        println!("lab above edge: {}, above edit: {}", above(lab, edge), above(lab, edit_frame));

        let (ox, oy, scale) = page_origin(edge);
        let at = |cx: f64, cy: f64| (ox + (cx * scale) as i32, oy + (cy * scale) as i32);
        let button = at(120.0, 60.0);
        let field = at(180.0, 140.0);
        let er = rect_of(edit);
        let edit_pt = ((er.left + er.right) / 2, (er.top + er.bottom) / 2);
        let lr = rect_of(lab);
        let tile = match (rest.first(), rest.get(1)) {
            (Some(x), Some(y)) => (
                lr.left + (x.parse::<f64>().unwrap() * (lr.right - lr.left) as f64) as i32,
                lr.top + (y.parse::<f64>().unwrap() * (lr.bottom - lr.top) as f64) as i32,
            ),
            _ => (lr.left + (lr.right - lr.left) * 3 / 4, lr.top + (lr.bottom - lr.top) / 2),
        };
        println!("page origin ({ox},{oy}) scale {scale}; button {button:?}, field {field:?}, edit {edit_pt:?}, tile point {tile:?}");

        /* Occlusion is `visible`'s question: asked here it read stale. */

        /* ── 1. flash, no input ── */
        println!("\n== flash: every composition frame of the lab, scored against the first ==");
        let s = sample(lr);
        thread::sleep(Duration::from_millis(1500));
        println!("  control, nothing touched:   {}", summary(&s.finish()));
        for how in [Through::Transparent, Through::LayeredTransparent, Through::RegionHole] {
            let s = sample(lr);
            thread::sleep(Duration::from_millis(100));
            let mut on = Duration::ZERO;
            for _ in 0..20 {
                let t = Instant::now();
                through_on(lab, how, button, base_ex);
                on += t.elapsed();
                thread::sleep(Duration::from_millis(5));
                let t = Instant::now();
                through_off(lab, how, base_ex);
                on += t.elapsed();
                thread::sleep(Duration::from_millis(60));
            }
            thread::sleep(Duration::from_millis(200));
            println!(
                "  {:<20} x20: {} (toggle calls {:.2} ms each)",
                format!("{how:?}"),
                summary(&s.finish()),
                ms(on) / 40.0
            );
        }
        let s = sample(lr);
        for _ in 0..10 {
            zorder(lab, HWND_TOPMOST);
            thread::sleep(Duration::from_millis(30));
            zorder(lab, HWND_NOTOPMOST);
            thread::sleep(Duration::from_millis(30));
        }
        thread::sleep(Duration::from_millis(200));
        println!("  {:<20} x10: {}", "Topmost on/off", summary(&s.finish()));
        bail_on_escape!();

        /* ── 2. hit test, no input ── */
        println!("\n== hit test: what WindowFromPoint finds at the button, under each ==");
        println!("  as it is: {}", if root_at(button.0, button.1) == lab { "the lab" } else { "something else" });
        let mut working = Vec::new();
        for how in [Through::Transparent, Through::LayeredTransparent, Through::RegionHole] {
            through_on(lab, how, button, base_ex);
            let r = root_at(button.0, button.1);
            through_off(lab, how, base_ex);
            let ok = r == edge;
            println!("  {how:?}: {}", if ok { "edge (passes through)" } else if r == lab { "the lab (blocked)" } else { "something else" });
            if ok {
                working.push(how);
            }
        }
        if working.is_empty() {
            println!("nothing lets a click through; stopping before any input");
            return;
        }
        bail_on_escape!();

        /* ── 3. real input ── */
        zorder(lab, HWND_TOPMOST);
        println!("\n== input (lab is now TOPMOST) ==");
        click_at(tile.0, tile.1);
        thread::sleep(Duration::from_millis(250));
        let c = cursor();
        println!(
            "  tile click: cursor at {c:?} (asked {tile:?}), foreground is {}",
            if unsafe { GetForegroundWindow() } == lab { "the lab" } else { "NOT the lab" }
        );

        for &how in &working {
            bail_on_escape!();
            println!("  -- {how:?} --");
            let s = sample(lr);
            let before = settle_page(edge);
            let mut on = Vec::new();
            let mut away = Vec::new();
            let mut fg = 0;
            let mut stays = 0;
            let mut blurs = 0;
            let trials = 8;
            for _ in 0..trials {
                click_at(tile.0, tile.1);
                thread::sleep(Duration::from_millis(120));
                let b0 = page_of(edge).unwrap_or_default().b;
                let (a, b) = drive_click(lab, how, button, tile, base_ex);
                on.push(ms(a));
                away.push(ms(b));
                thread::sleep(Duration::from_millis(150));
                if unsafe { GetForegroundWindow() } == edge {
                    fg += 1;
                }
                if above(lab, edge) {
                    stays += 1;
                }
                let _ = b0;
                blurs = page_of(edge).unwrap_or_default().b;
            }
            let after = settle_page(edge);
            println!(
                "  {trials} tile-click → drive-click: page counted {} clicks, edge foreground after {fg}/{trials}, lab still above edge {stays}/{trials}",
                after.c - before.c
            );
            println!(
                "  page blurred {} times across them (a tile click activates Volery)",
                blurs - before.b
            );
            on.sort_by(f64::total_cmp);
            away.sort_by(f64::total_cmp);
            println!(
                "  click-through held {:.2}..{:.2} ms (median {:.2}); cursor away {:.2}..{:.2} ms (median {:.2})",
                on[0],
                on[on.len() - 1],
                on[on.len() / 2],
                away[0],
                away[away.len() - 1],
                away[away.len() / 2]
            );
            println!("  frames meanwhile: {}", summary(&s.finish()));
        }
        let how = working[0];
        bail_on_escape!();

        /* keys into the field, after a through-the-tile click on it */
        click_at(tile.0, tile.1);
        thread::sleep(Duration::from_millis(120));
        drive_click(lab, how, field, tile, base_ex);
        thread::sleep(Duration::from_millis(150));
        let s = sample(lr);
        aim_keys(lab);
        send(&[key(SCAN_CTRL, false), key(SCAN_A_POS, false), key(SCAN_A_POS, true), key(SCAN_CTRL, true)]);
        thread::sleep(Duration::from_millis(30));
        aim_keys(lab);
        type_scans(&[SCAN_H, SCAN_E, SCAN_L, SCAN_L, SCAN_O, SCAN_ENTER]);
        let p = settle_page(edge);
        println!(
            "\n  keys after a drive-click on the field: value {:?}, Enter saw {:?}; frames while typing: {}",
            p.v,
            p.e,
            summary(&s.finish())
        );
        let (r, v) = frame_rate(edge);
        println!("  the page while driven, under the topmost lab: {r:.1} rAF/s vis={v}");
        bail_on_escape!();

        /* keys with no click: Volery hands the foreground over itself */
        click_at(tile.0, tile.1);
        thread::sleep(Duration::from_millis(150));
        let fg_thread = unsafe { GetWindowThreadProcessId(GetForegroundWindow(), None) };
        let me = unsafe { GetCurrentThreadId() };
        let handed = unsafe {
            let _ = AttachThreadInput(me, fg_thread, true);
            let ok = SetForegroundWindow(edge).as_bool();
            let _ = AttachThreadInput(me, fg_thread, false);
            ok
        };
        thread::sleep(Duration::from_millis(100));
        aim_keys(lab);
        type_scans(&[SCAN_X, SCAN_Y]);
        let p = settle_page(edge);
        println!(
            "  SetForegroundWindow(edge) from the lab's foreground: {handed}, edge foreground {}, lab above {}, value now {:?}",
            unsafe { GetForegroundWindow() } == edge,
            above(lab, edge),
            p.v
        );
        bail_on_escape!();

        /* the wheel, two ways */
        let y0 = settle_page(edge).y;
        let wp = WPARAM(((-120i32 as u16 as usize) << 16) as usize);
        let lp = LPARAM((((button.1 as u16 as u32) << 16) | button.0 as u16 as u32) as isize);
        unsafe {
            let _ = PostMessageW(Some(edge), WM_MOUSEWHEEL, wp, lp);
        }
        let y1 = settle_page(edge).y;
        let target = root_at_below(lab, button);
        unsafe {
            let _ = PostMessageW(Some(target), WM_MOUSEWHEEL, wp, lp);
        }
        let y2 = settle_page(edge).y;
        aim_through(lab, button);
        through_on(lab, how, button, base_ex);
        send(&[move_to(button.0, button.1), mouse(MOUSEEVENTF_WHEEL, 0, 0, -120), move_to(tile.0, tile.1)]);
        let deadline = Instant::now() + Duration::from_millis(300);
        while cursor() != tile && Instant::now() < deadline {}
        through_off(lab, how, base_ex);
        let y3 = settle_page(edge).y;
        println!(
            "\n  wheel: PostMessage to edge's frame scrolled {}px; to the window found under the point ({}) {}px; SendInput through the lab {}px",
            y1 - y0,
            class_of(target),
            y2 - y1,
            y3 - y2
        );
        bail_on_escape!();

        /* a drag selecting text in the field */
        // scroll back to the top first, so the field is where it was
        unsafe {
            let _ = PostMessageW(Some(target), WM_MOUSEWHEEL, WPARAM(((120i32 * 20) as u16 as usize) << 16), lp);
        }
        thread::sleep(Duration::from_millis(300));
        let (a, b) = (at(30.0, 140.0), at(200.0, 140.0));
        click_at(tile.0, tile.1);
        thread::sleep(Duration::from_millis(120));
        aim_through(lab, a);
        aim_through(lab, b);
        let t = Instant::now();
        through_on(lab, how, a, base_ex);
        // a region hole only covers one point, so a drag needs the style
        if how == Through::RegionHole {
            through_off(lab, how, base_ex);
            through_on(lab, Through::Transparent, a, base_ex);
        }
        send(&[move_to(a.0, a.1), mouse(MOUSEEVENTF_LEFTDOWN, 0, 0, 0)]);
        for i in 1..=10 {
            let x = a.0 + (b.0 - a.0) * i / 10;
            send(&[move_to(x, a.1)]);
            thread::sleep(Duration::from_millis(12));
        }
        send(&[mouse(MOUSEEVENTF_LEFTUP, 0, 0, 0), move_to(tile.0, tile.1)]);
        thread::sleep(Duration::from_millis(30));
        through_off(lab, Through::Transparent, base_ex);
        through_off(lab, how, base_ex);
        let p = settle_page(edge);
        println!("  drag across the field ({:.0} ms away): selection {}", ms(t.elapsed()), p.s);
        bail_on_escape!();

        /* the classic Win32 edit control */
        click_at(tile.0, tile.1);
        thread::sleep(Duration::from_millis(120));
        drive_click(lab, how, edit_pt, tile, base_ex);
        thread::sleep(Duration::from_millis(150));
        aim_keys(lab);
        type_scans(&[SCAN_H, SCAN_E, SCAN_L, SCAN_L, SCAN_O]);
        thread::sleep(Duration::from_millis(150));
        println!(
            "  win32 EDIT after a drive-click and keys: {:?}, foreground is the edit window: {}, lab above it: {}",
            edit_text(edit),
            unsafe { GetForegroundWindow() } == edit_frame,
            above(lab, edit_frame)
        );

        drop(guard);
    }

    unsafe extern "system" fn cover_proc(h: HWND, m: u32, w: WPARAM, l: LPARAM) -> LRESULT {
        DefWindowProcW(h, m, w, l)
    }

    /// A plain topmost window of this probe's own, covering a rectangle, on a
    /// thread that pumps it. `exclude` sets `WDA_EXCLUDEFROMCAPTURE`, which
    /// only the owning process may — so this is how that question gets asked
    /// without a build of Volery that sets it.
    fn cover_window(x: i32, y: i32, w: i32, h: i32, exclude: bool) -> isize {
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || unsafe {
            let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            let inst = windows::Win32::System::LibraryLoader::GetModuleHandleW(None).unwrap();
            let wc = WNDCLASSW {
                lpfnWndProc: Some(cover_proc),
                hInstance: inst.into(),
                lpszClassName: w!("DriveProbeCover"),
                hbrBackground: windows::Win32::Graphics::Gdi::HBRUSH(
                    windows::Win32::Graphics::Gdi::GetStockObject(windows::Win32::Graphics::Gdi::GRAY_BRUSH).0,
                ),
                ..Default::default()
            };
            RegisterClassW(&wc);
            let win = CreateWindowExW(
                WS_EX_TOPMOST,
                w!("DriveProbeCover"),
                w!("drive-probe cover"),
                windows::Win32::UI::WindowsAndMessaging::WS_POPUP | WS_VISIBLE,
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
            if exclude {
                let _ = windows::Win32::UI::WindowsAndMessaging::SetWindowDisplayAffinity(
                    win,
                    windows::Win32::UI::WindowsAndMessaging::WDA_EXCLUDEFROMCAPTURE,
                );
            }
            tx.send(win.0 as isize).unwrap();
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        });
        rx.recv().unwrap()
    }

    fn close_window(h: HWND) {
        unsafe {
            let _ = PostMessageW(Some(h), WM_CLOSE, WPARAM(0), LPARAM(0));
        }
    }

    /// Make Chromium recompute occlusion. Its tracker listens for window
    /// events — a move among them — and not for another process's window
    /// changing style, so a style alone leaves the last answer standing; a
    /// pixel's move of `h` and back is the cheapest event that is certain.
    fn nudge(h: HWND) {
        let r = rect_of(h);
        let topmost = exstyle(h) & WS_EX_TOPMOST.0 != 0;
        if topmost {
            zorder(h, HWND_NOTOPMOST);
            zorder(h, HWND_TOPMOST);
        }
        unsafe {
            let flags = SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE;
            let _ = SetWindowPos(h, None, r.left + 1, r.top, 0, 0, flags);
            let _ = SetWindowPos(h, None, r.left, r.top, 0, 0, flags);
        }
    }

    /// Which style of Volery's Chromium counts as covering a window beneath
    /// it, recomputed after each and bracketed by controls so a stale answer
    /// shows itself. No input at all.
    fn visible(lab: HWND, dir: &Path) {
        let base_ex = exstyle(lab);
        let mut guard = Restore { lab, ex: base_ex, rect: rect_of(lab), cursor: cursor(), edge: None, edit_frame: None };
        let (lx, ly, lw, lh) = (200, 120, 1300, 800);
        place(lab, None, lx, ly, lw, lh);
        let (edge_child, edge) = launch_edge(dir, lx + 60, ly + 60, 800, 600);
        guard.edge = Some((edge_child, edge));
        place(edge, None, lx + 60, ly + 60, 800, 600);
        thread::sleep(Duration::from_millis(1500));
        let (r, v) = frame_rate(edge);
        println!("\ncontrol: nothing over edge:                     {r:6.1} rAF/s vis={v}");
        zorder(lab, HWND_TOPMOST);
        let lr = rect_of(lab);
        let corner = (lr.left + 3, lr.top + 3);

        let measure = |label: &str, ex: u32, alpha: Option<u8>, hole: bool| {
            set_exstyle(lab, ex);
            if let Some(a) = alpha {
                unsafe {
                    let _ = SetLayeredWindowAttributes(lab, COLORREF(0), a, LWA_ALPHA);
                }
            }
            if hole {
                through_on(lab, Through::RegionHole, corner, ex);
            }
            nudge(lab);
            nudge(edge);
            thread::sleep(Duration::from_millis(2500));
            let (r, v) = frame_rate(edge);
            println!("  {label:<46} {r:6.1} rAF/s  vis={v}");
            if hole {
                through_off(lab, Through::RegionHole, ex);
            }
            set_exstyle(lab, base_ex);
        };
        println!("\n== the lab topmost over edge, recomputed after each ==");
        measure("as it is", base_ex, None, false);
        measure("WS_EX_TRANSPARENT (alone: not click-through)", base_ex | WS_EX_TRANSPARENT.0, None, false);
        measure("  as it is", base_ex, None, false);
        measure("LAYERED alpha 255", base_ex | WS_EX_LAYERED.0, Some(255), false);
        measure("  as it is", base_ex, None, false);
        measure("LAYERED alpha 254", base_ex | WS_EX_LAYERED.0, Some(254), false);
        measure("  as it is", base_ex, None, false);
        measure("a 5px region hole in a corner", base_ex, None, true);
        measure("  as it is", base_ex, None, false);
        measure("TOOLWINDOW", base_ex | WS_EX_TOOLWINDOW.0, None, false);
        measure("  as it is", base_ex, None, false);
        bail_on_escape!();

        /* the wheel by message, with no cursor: Chromium routes a wheel to the
           window under the message's point, which is the lab unless the lab
           lets it through for the moment the message is handled */
        set_exstyle(lab, base_ex | WS_EX_TRANSPARENT.0);
        nudge(lab);
        thread::sleep(Duration::from_millis(1500));
        let (ox, oy, scale) = page_origin(edge);
        let p = (ox + (120.0 * scale) as i32, oy + (60.0 * scale) as i32);
        let wp = WPARAM(((-120i32 as u16 as usize) << 16) as usize);
        let lp = LPARAM((((p.1 as u16 as u32) << 16) | p.0 as u16 as u32) as isize);
        let pg = settle_page(edge);
        let y0 = pg.y;
        unsafe {
            let _ = PostMessageW(Some(edge), WM_MOUSEWHEEL, wp, lp);
        }
        let y1 = settle_page(edge).y;
        let kept = base_ex | WS_EX_TRANSPARENT.0;
        through_on(lab, Through::LayeredTransparent, p, kept);
        let t = Instant::now();
        unsafe {
            let mut res = 0usize;
            let _ = windows::Win32::UI::WindowsAndMessaging::SendMessageTimeoutW(
                edge,
                WM_MOUSEWHEEL,
                wp,
                lp,
                windows::Win32::UI::WindowsAndMessaging::SMTO_ABORTIFHUNG,
                200,
                Some(&mut res),
            );
        }
        let held = t.elapsed();
        through_off(lab, Through::LayeredTransparent, kept);
        let y2 = settle_page(edge).y;
        through_on(lab, Through::LayeredTransparent, p, kept);
        unsafe {
            let _ = PostMessageW(Some(edge), WM_MOUSEWHEEL, wp, lp);
        }
        thread::sleep(Duration::from_millis(30));
        through_off(lab, Through::LayeredTransparent, kept);
        let y3 = settle_page(edge).y;
        println!(
            "\n  wheel, page vis={}: PostMessage, lab in the way {}px; SendMessage with the lab let through {}px ({:.2} ms); PostMessage + 30ms let through {}px",
            pg.vis,
            y1 - y0,
            y2 - y1,
            ms(held),
            y3 - y2
        );
        set_exstyle(lab, base_ex);
        bail_on_escape!();

        /* WDA_EXCLUDEFROMCAPTURE, on a cover of the probe's own */
        place(lab, Some(HWND_NOTOPMOST), 1100, 120, 400, 300);
        nudge(lab);
        thread::sleep(Duration::from_millis(1500));
        let (r, v) = frame_rate(edge);
        println!("\ncontrol: lab moved off edge:                   {r:6.1} rAF/s vis={v}");
        let er = rect_of(edge);
        println!("== a topmost window of the probe's own covering edge ==");
        for exclude in [false, true] {
            let c = HWND(cover_window(er.left - 20, er.top - 20, er.right - er.left + 40, er.bottom - er.top + 40, exclude) as *mut _);
            thread::sleep(Duration::from_millis(200));
            nudge(c);
            nudge(edge);
            thread::sleep(Duration::from_millis(1500));
            let (r, v) = frame_rate(edge);
            println!(
                "  {:<46} {r:6.1} rAF/s  vis={v}  (cover above edge {})",
                if exclude { "with WDA_EXCLUDEFROMCAPTURE" } else { "plain" },
                above(c, edge)
            );
            close_window(c);
            thread::sleep(Duration::from_millis(300));
        }
        drop(guard);
    }

    /// A viewer that keeps what it was sent: the hold's phases, here.
    struct Heard(std::sync::Mutex<Vec<String>>);

    impl skein_lib::cast::Viewer for Heard {
        fn send(&self, out: skein_lib::cast::Out) -> bool {
            if let skein_lib::cast::Out::Text(t) = out {
                self.0.lock().unwrap().push(t.to_string());
            }
            true
        }
    }

    /// `cast::drive` itself, end to end against a lab's window: the drive
    /// installed as the app will install it, and pointer events handed to it
    /// as the tile would.
    ///
    /// **No Escape.** The hold is tested by a person pressing it, never by
    /// this probe: see `STAGE` for the run that taught that. The run ends by
    /// turning the drive off the way the app does.
    fn drive(lab: HWND, dir: &Path) {
        use skein_lib::cast::drive::Drive;
        use skein_lib::cast::{Button as B, Input as I, Monitor};

        let found = exstyle(lab);
        let clean = found & !(WS_EX_TRANSPARENT.0 | 0x0800_0000 | WS_EX_LAYERED.0);
        if clean != found {
            println!("the lab came in wearing ex=0x{found:08x}; scrubbed to 0x{clean:08x}");
            set_exstyle(lab, clean);
        }
        let base_ex = exstyle(lab);
        let mut guard = Restore { lab, ex: base_ex, rect: rect_of(lab), cursor: cursor(), edge: None, edit_frame: None };
        let (lx, ly, lw, lh) = (200, 120, 1300, 800);
        place(lab, None, lx, ly, lw, lh);
        let (edge_child, edge) = launch_edge(dir, lx + 60, ly + 60, 800, 600);
        guard.edge = Some((edge_child, edge));
        place(edge, None, lx + 60, ly + 60, 800, 600);
        thread::sleep(Duration::from_millis(1500));

        // the "monitor" is the whole virtual desktop, so a tile point is a desktop point
        let (vx, vy, vw, vh) = unsafe {
            (
                GetSystemMetrics(SM_XVIRTUALSCREEN),
                GetSystemMetrics(SM_YVIRTUALSCREEN),
                GetSystemMetrics(SM_CXVIRTUALSCREEN),
                GetSystemMetrics(SM_CYVIRTUALSCREEN),
            )
        };
        let mon = Monitor {
            id: "probe".into(),
            name: "virtual desktop".into(),
            w: vw as u32,
            h: vh as u32,
            x: vx,
            y: vy,
            hz: 60,
            primary: true,
        };
        let norm = |p: (i32, i32)| I::MouseAbs {
            x: (((p.0 - vx) as i64 * 65535 + (vw as i64 - 1) / 2) / (vw as i64 - 1)) as u16,
            y: (((p.1 - vy) as i64 * 65535 + (vh as i64 - 1) / 2) / (vh as i64 - 1)) as u16,
        };

        stage(&[lab, edge]);
        raise_under_lab(edge);
        let heard = Arc::new(Heard(std::sync::Mutex::new(Vec::new())));
        let mut d = Drive::start(lab.0 as isize, &mon, heard.clone()).expect("drive starts");
        thread::sleep(Duration::from_millis(200));
        let ex = exstyle(lab);
        println!(
            "\n== drive on ==\n  lab style: TRANSPARENT {}, NOACTIVATE {}, TOPMOST {}; above edge {}",
            ex & WS_EX_TRANSPARENT.0 != 0,
            ex & 0x0800_0000 != 0,
            ex & WS_EX_TOPMOST.0 != 0,
            above(lab, edge)
        );

        let lr = rect_of(lab);
        let tile = (lr.left + (lr.right - lr.left) * 3 / 4, lr.top + (lr.bottom - lr.top) / 2);
        let (ox, oy, scale) = page_origin(edge);
        let at = |cx: f64, cy: f64| (ox + (cx * scale) as i32, oy + (cy * scale) as i32);
        let (button, field) = (at(120.0, 60.0), at(180.0, 140.0));

        // a click on the tile, as a hand makes it: does it take the foreground?
        let before = unsafe { GetForegroundWindow() };
        click_at(tile.0, tile.1);
        thread::sleep(Duration::from_millis(200));
        println!(
            "  a physical click on the tile: lab took the foreground {}",
            unsafe { GetForegroundWindow() } == lab && before != lab
        );
        bail_on_escape!();

        // clicks, as the tile hands them over: three ways, each trial scored
        let one = |tile_click: bool, gap: u64| -> bool {
            if tile_click {
                click_at(tile.0, tile.1);
            }
            thread::sleep(Duration::from_millis(gap));
            let c0 = page_of(edge).unwrap_or_default().c;
            aim_through(lab, button);
            d.apply(&[norm(button), I::Button { button: B::Left, down: true }, I::Button { button: B::Left, down: false }]);
            thread::sleep(Duration::from_millis(250));
            page_of(edge).unwrap_or_default().c > c0
        };
        let p0 = settle_page(edge);
        for (label, tile_click, gap) in [
            ("tile click, then 80 ms", true, 80u64),
            ("no tile click", false, 80),
            ("tile click, then 400 ms", true, 400),
        ] {
            let hits: String = (0..10).map(|_| if one(tile_click, gap) { 'x' } else { '.' }).collect();
            // spaced past the double-click time, so no two trials make a double click
            thread::sleep(Duration::from_millis(300));
            println!("  {label:<24} {hits}  ({} of 10 landed)", hits.matches('x').count());
        }
        thread::sleep(Duration::from_millis(500));
        let p1 = settle_page(edge);
        println!(
            "  the page's own count: {} of 30; it blurred {} times; edge foreground {}, lab above {}",
            p1.c - p0.c,
            p1.b - p0.b,
            unsafe { GetForegroundWindow() } == edge,
            above(lab, edge)
        );
        let (ok, gave_up) = skein_lib::cast::drive::settles();
        println!("  clicks the hook saw delivered: {ok}; gave up waiting: {gave_up}");
        let (r, v) = frame_rate(edge);
        println!("  the page while driven, under the lab: {r:.1} rAF/s vis={v}");
        bail_on_escape!();

        // the field, then keys from "the keyboard"
        aim_through(lab, field);
        d.apply(&[norm(field), I::Button { button: B::Left, down: true }, I::Button { button: B::Left, down: false }]);
        thread::sleep(Duration::from_millis(250));
        aim_keys(lab);
        type_scans(&[SCAN_H, SCAN_E, SCAN_L, SCAN_L, SCAN_O, SCAN_ENTER]);
        let p = settle_page(edge);
        println!("  keys after a drive click on the field: value {:?}, Enter saw {:?}", p.v, p.e);

        // the wheel
        // a page scrolls smoothly, so each reading waits out the animation
        let settled = || {
            thread::sleep(Duration::from_millis(700));
            page_of(edge).unwrap_or_default().y
        };
        let y0 = settled();
        aim_through(lab, button);
        d.apply(&[norm(button), I::Wheel { dx: 0, dy: -120 }]);
        let y1 = settled();
        aim_through(lab, button);
        d.apply(&[norm(button), I::Wheel { dx: 0, dy: -240 }]);
        let y2 = settled();
        println!("  wheel through drive: one notch down {}px, then two more {}px", y1 - y0, y2 - y1);
        bail_on_escape!();

        // a drag across the field
        let (a, b) = (at(30.0, 140.0), at(220.0, 140.0));
        let mut ev = vec![norm(a), I::Button { button: B::Left, down: true }];
        for i in 1..=8 {
            ev.push(norm((a.0 + (b.0 - a.0) * i / 8, a.1)));
        }
        ev.push(I::Button { button: B::Left, down: false });
        aim_through(lab, a);
        aim_through(lab, b);
        d.apply(&ev);
        thread::sleep(Duration::from_millis(400));
        println!("  drag through drive: selection {}", settle_page(edge).s);
        bail_on_escape!();

        d.leave();
        thread::sleep(Duration::from_millis(300));
        let ex = exstyle(lab);
        let c0 = settle_page(edge).c;
        d.apply(&[norm(button), I::Button { button: B::Left, down: true }, I::Button { button: B::Left, down: false }]);
        let c1 = settle_page(edge).c;
        println!(
            "  drive turned off: lab TRANSPARENT now {}, TOPMOST {}, foreground {}; a press after it reached the page: {}",
            ex & WS_EX_TRANSPARENT.0 != 0,
            ex & WS_EX_TOPMOST.0 != 0,
            unsafe { GetForegroundWindow() } == lab,
            c1 != c0
        );
        drop(d);
        drop(guard);

    }

    /// What the tile's point hit-tests as while a drive is on, and the lab's
    /// style, sampled with no input at all. Asked because a guarded run found
    /// the point hit-testing as the window *under* the lab a moment after the
    /// drive began — the lab gone click-through to real clicks too.
    fn hits(lab: HWND, dir: &Path, wait_ms: u64) {
        use skein_lib::cast::drive::Drive;
        use skein_lib::cast::Monitor;

        let found = exstyle(lab);
        let clean = found & !(WS_EX_TRANSPARENT.0 | 0x0800_0000 | WS_EX_LAYERED.0);
        if clean != found {
            println!("the lab came in wearing ex=0x{found:08x}; scrubbed to 0x{clean:08x}");
            set_exstyle(lab, clean);
        }
        let base_ex = exstyle(lab);
        stage(&[lab]);
        let mut guard = Restore { lab, ex: base_ex, rect: rect_of(lab), cursor: cursor(), edge: None, edit_frame: None };
        let (lx, ly, lw, lh) = (200, 120, 1300, 800);
        place(lab, None, lx, ly, lw, lh);
        let (edge_child, edge) = launch_edge(dir, lx + 60, ly + 60, 800, 600);
        guard.edge = Some((edge_child, edge));
        place(edge, None, lx + 60, ly + 60, 800, 600);
        thread::sleep(Duration::from_millis(1500));
        raise_under_lab(edge);
        let lr = rect_of(lab);
        let tile = (lr.left + (lr.right - lr.left) * 3 / 4, lr.top + (lr.bottom - lr.top) / 2);
        let (vx, vy, vw, vh) = unsafe {
            (
                GetSystemMetrics(SM_XVIRTUALSCREEN),
                GetSystemMetrics(SM_YVIRTUALSCREEN),
                GetSystemMetrics(SM_CXVIRTUALSCREEN),
                GetSystemMetrics(SM_CYVIRTUALSCREEN),
            )
        };
        let mon = Monitor { id: "probe".into(), name: "virtual desktop".into(), w: vw as u32, h: vh as u32, x: vx, y: vy, hz: 60, primary: true };

        let read = |label: &str, t0: Instant| {
            let r = root_at(tile.0, tile.1);
            let ex = exstyle(lab);
            format!(
                "{label:>10} +{:>5.0} ms: tile point hit-tests as {} — lab ex=0x{ex:08x}{}{}{}{}",
                ms(t0.elapsed()),
                if r == lab { "THE LAB".to_string() } else { format!("'{}' ({})", text_of(r), class_of(r)) },
                if ex & WS_EX_TRANSPARENT.0 != 0 { " TRANSPARENT" } else { "" },
                if ex & 0x0800_0000 != 0 { " NOACTIVATE" } else { "" },
                if ex & WS_EX_LAYERED.0 != 0 { " LAYERED" } else { "" },
                if ex & WS_EX_TOPMOST.0 != 0 { " TOPMOST" } else { "" },
            )
        };
        let t0 = Instant::now();
        println!("{}", read("before", t0));
        let heard = Arc::new(Heard(std::sync::Mutex::new(Vec::new())));
        let d = Drive::start(lab.0 as isize, &mon, heard.clone()).expect("drive starts");
        let t0 = Instant::now();
        let mut last = String::new();
        while t0.elapsed() < Duration::from_millis(wait_ms) {
            let line = read("driving", t0);
            let key = line.split(": ").nth(1).unwrap_or("").to_string();
            if key != last {
                println!("{line}");
                last = key;
            }
            thread::sleep(Duration::from_millis(20));
        }
        println!("{}", read("end", t0));

        // one click on the tile, guarded, then watch again
        let inner = |t0: Instant| {
            let mut v = Vec::new();
            for c in children(lab) {
                v.push(format!("{}=0x{:08x}", class_of(c), exstyle(c)));
            }
            let deep = unsafe { windows::Win32::UI::WindowsAndMessaging::WindowFromPoint(POINT { x: tile.0, y: tile.1 }) };
            format!("   +{:>5.0} ms deepest at the point: {} ({}); inner: {}", ms(t0.elapsed()), class_of(deep), text_of(deep), v.join(" "))
        };
        println!("{}", inner(t0));
        click_at(tile.0, tile.1);
        let t1 = Instant::now();
        let mut last = String::new();
        while t1.elapsed() < Duration::from_millis(4000) {
            let line = read("clicked", t1);
            let key = line.split(": ").nth(1).unwrap_or("").to_string();
            if key != last {
                println!("{line}");
                println!("{}", inner(t1));
                last = key;
            }
            thread::sleep(Duration::from_millis(20));
        }
        println!("{}", read("end", t1));
        drop(d);
        thread::sleep(Duration::from_millis(200));
        println!("{}", read("dropped", t1));
        drop(guard);
        thread::sleep(Duration::from_millis(1500));
        println!("{}", read("restored", t1));
    }

    /// The window under a point, skipping the lab: walk the z-order below it
    /// and take the first visible top-level whose rectangle holds the point.
    fn root_at_below(lab: HWND, p: (i32, i32)) -> HWND {
        let mut h = lab;
        loop {
            match unsafe { GetWindow(h, GW_HWNDNEXT) } {
                Ok(n) if !n.is_invalid() => {
                    let r = rect_of(n);
                    if unsafe { IsWindowVisible(n).as_bool() }
                        && p.0 >= r.left
                        && p.0 < r.right
                        && p.1 >= r.top
                        && p.1 < r.bottom
                    {
                        return n;
                    }
                    h = n;
                }
                _ => return lab,
            }
        }
    }
}
