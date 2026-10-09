//! What answers a double-click while WebView2 is starting.
//!
//! Measured 2026-10-09 on release builds over a copy of Lyss's wall (274 cards,
//! 1981 turns), ten interleaved launches a version, medians from process
//! creation: the store opens in 17ms, migrating it costs 1ms (18 on the launch
//! after an upgrade), the rest of `open_wall` 12ms — and then the first webview
//! takes ~0.6-1.5s to build and the second ~0.2-0.5s, because the first is what
//! starts `msedgewebview2.exe`, and how long that takes is mostly how busy the
//! machine is. So the studio window appeared 0.9-2.2s after the double-click
//! with nothing on screen before it, in 0.46 and 0.47 alike. That is a wait
//! long enough to make a person double-click again, and the second launch now
//! meets `claim_wall`'s "already running" box.
//!
//! **Not a webview, and that is the whole design.** Tauri's own splash pattern
//! is a second webview window, and it would pay that same start-up before it
//! could appear — the larger part of the wait it exists to cover. This one is
//! up ~80ms after process creation (median of ten, 63-95). It also cannot call
//! a Tauri command, which is the bug `open_windows` exists to prevent: a page
//! that called one before the store existed. Here that is not a rule somebody
//! keeps but a thing that cannot be done, since there is no page.
//!
//! What it is: the studio's ground and one quiet line, in the rectangle the
//! studio is about to take (`window::foreseen`), so the window that replaces
//! it arrives where the eye already is, in the same `#151210` its own
//! `backgroundColor` paints. No spinner and no bar — it cannot measure
//! progress, so it does not draw any.
//!
//! The bounds it keeps:
//!
//! - **It never takes the keyboard.** `WS_EX_NOACTIVATE`, shown with
//!   `SW_SHOWNOACTIVATE`, and `MA_NOACTIVATE` to a click — so when it goes,
//!   focus is wherever `window::settle` put it, never nowhere.
//! - **It goes on every path.** `open_windows` lowers it the moment the studio
//!   is shown; `complain` lowers it before its box, and the panic hook speaks
//!   through `complain`, so no failure is ever explained under it. It is not
//!   topmost and it belongs to this process, so a process that dies takes it
//!   along — there is no orphan to leave.
//! - **A message box pumping it is harmless.** The window procedure holds no
//!   state it could be re-entered over: it paints from two atomics and that is
//!   all. And `complain` takes it down before the box is up anyway.
//! - **Not on a driven launch.** A wall with the control surface armed opens
//!   without interrupting what you were doing (`window::opens_quietly`), and a
//!   splash over your work would be exactly that interruption.

use crate::window::Frame;

/// Put the splash up over `frame`, drawn at `scale`. Once per launch, from the
/// main thread, and a failure is silent: a splash that could not be made leaves
/// the wait there was before, which is no worse than not having tried.
#[cfg(windows)]
pub fn raise(frame: Frame, scale: f64) {
    os::raise(frame, scale)
}

/// Take it down, if it is up. Safe to call any number of times, from anywhere.
#[cfg(windows)]
pub fn lower() {
    os::lower()
}

/* A splash is a courtesy rather than a capability, so elsewhere it is simply
   absent — the convention that a non-Windows arm errors is about promises a
   caller relies on, and nothing relies on this. */
#[cfg(not(windows))]
pub fn raise(_frame: Frame, _scale: f64) {}
#[cfg(not(windows))]
pub fn lower() {}

#[cfg(windows)]
mod os {
    use super::Frame;
    use std::sync::atomic::{AtomicIsize, AtomicU32, Ordering};
    use windows::core::w;
    use windows::Win32::Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows::Win32::Graphics::Gdi::{
        BeginPaint, CreateFontW, CreateSolidBrush, DeleteObject, DrawTextW, EndPaint, FillRect,
        SelectObject, SetBkMode, SetTextColor, UpdateWindow, CLEARTYPE_QUALITY,
        CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET, DT_CENTER, DT_SINGLELINE, DT_VCENTER,
        OUT_DEFAULT_PRECIS, PAINTSTRUCT, TRANSPARENT,
    };
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, GetClientRect, PostMessageW,
        RegisterClassExW, ShowWindow, MA_NOACTIVATE, SW_SHOWNOACTIVATE, WM_CLOSE,
        WM_ERASEBKGND, WM_MOUSEACTIVATE, WM_PAINT, WNDCLASSEXW, WS_EX_NOACTIVATE,
        WS_EX_TOOLWINDOW, WS_POPUP,
    };

    /// The splash's window, or 0. Taken with a swap, so exactly one caller
    /// ever destroys it.
    static UP: AtomicIsize = AtomicIsize::new(0);
    /// The thread that made it, which is the only one `DestroyWindow` works on.
    static OWNER: AtomicU32 = AtomicU32::new(0);
    /// The line's height in physical pixels, fixed when it is raised.
    static TEXT_PX: AtomicU32 = AtomicU32::new(15);

    /// `--ink` and `--paper-faint` from `tokens.css`, as `0x00BBGGRR`.
    const GROUND: COLORREF = COLORREF(0x0010_1215);
    const LINE: COLORREF = COLORREF(0x0050_5861);

    pub fn raise(frame: Frame, scale: f64) {
        if UP.load(Ordering::SeqCst) != 0 {
            return;
        }
        TEXT_PX.store((15.0 * scale).round().max(1.0) as u32, Ordering::SeqCst);
        // SAFETY: plain Win32 calls with stack-owned arguments, on the thread
        // that will also destroy the window (or post to it, see `lower`).
        unsafe {
            let Ok(module) = GetModuleHandleW(None) else { return };
            let instance = HINSTANCE(module.0);
            let class = w!("VolerySplash");
            let wc = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                lpfnWndProc: Some(procedure),
                hInstance: instance,
                lpszClassName: class,
                ..Default::default()
            };
            /* Zero on a second registration in one process, which cannot happen
               with one raise per launch; the create below fails loudly enough
               if it ever did. */
            RegisterClassExW(&wc);
            let Ok(hwnd) = CreateWindowExW(
                WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                class,
                w!("Volery — opening"),
                WS_POPUP,
                frame.x,
                frame.y,
                frame.w as i32,
                frame.h as i32,
                None,
                None,
                Some(instance),
                None,
            ) else {
                return;
            };
            OWNER.store(GetCurrentThreadId(), Ordering::SeqCst);
            UP.store(hwnd.0 as isize, Ordering::SeqCst);
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            /* Paint now rather than when the loop next turns: the main thread
               goes straight into building a webview, and the first message it
               pumps is a second away. */
            let _ = UpdateWindow(hwnd);
        }
    }

    pub fn lower() {
        let raw = UP.swap(0, Ordering::SeqCst);
        if raw == 0 {
            return;
        }
        let hwnd = HWND(raw as *mut core::ffi::c_void);
        // SAFETY: a window this module made and nobody else holds.
        unsafe {
            if GetCurrentThreadId() == OWNER.load(Ordering::SeqCst) {
                let _ = DestroyWindow(hwnd);
            } else {
                /* Only its own thread may destroy it; `WM_CLOSE` asks that
                   thread to, via `DefWindowProcW`. */
                let _ = PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0));
            }
        }
    }

    unsafe extern "system" fn procedure(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
        match msg {
            /* `WM_PAINT` fills the whole client area, so erasing first would
               only be a flash of the class's (absent) brush. */
            WM_ERASEBKGND => LRESULT(1),
            WM_MOUSEACTIVATE => LRESULT(MA_NOACTIVATE as isize),
            WM_PAINT => {
                let mut ps = PAINTSTRUCT::default();
                let dc = BeginPaint(hwnd, &mut ps);
                let mut rect = RECT::default();
                let _ = GetClientRect(hwnd, &mut rect);
                let ground = CreateSolidBrush(GROUND);
                FillRect(dc, &rect, ground);
                let _ = DeleteObject(ground.into());
                let font = CreateFontW(
                    -(TEXT_PX.load(Ordering::SeqCst) as i32),
                    0,
                    0,
                    0,
                    400,
                    0,
                    0,
                    0,
                    DEFAULT_CHARSET,
                    OUT_DEFAULT_PRECIS,
                    CLIP_DEFAULT_PRECIS,
                    CLEARTYPE_QUALITY,
                    0,
                    /* `--body`, which Windows ships; GDI falls back on its own
                       if it is somehow absent. */
                    w!("Sitka Text"),
                );
                let before = SelectObject(dc, font.into());
                SetTextColor(dc, LINE);
                SetBkMode(dc, TRANSPARENT);
                let mut line: Vec<u16> = "opening the wall".encode_utf16().collect();
                DrawTextW(dc, &mut line, &mut rect, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
                SelectObject(dc, before);
                let _ = DeleteObject(font.into());
                let _ = EndPaint(hwnd, &ps);
                LRESULT(0)
            }
            _ => DefWindowProcW(hwnd, msg, wp, lp),
        }
    }
}
