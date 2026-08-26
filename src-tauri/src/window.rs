//! Where the studio window opens, and how big.
//!
//! `tauri.conf.json` asks for 1280×820 centred, and on most machines that is
//! exactly what should happen. On some it opened taller than the screen, with
//! the top of the window above the top of the display — and since
//! `decorations: false`, the top of the window *is* the title bar, so the drag
//! region and the window controls both went off-screen with no OS chrome
//! underneath to pull it back down by. There is no gesture left that fixes it.
//!
//! Two things made it, and neither is visible on the machine it was written on:
//!
//! - **The configured numbers are logical pixels**, divided by the monitor's
//!   scale factor before they reach the glass. A 1920×1080 panel at 100% has a
//!   1920×1080 logical desktop and 820 fits; the *same panel* at 150% has a
//!   1280×720 logical desktop, around 688 of it above the taskbar, and the
//!   window is asked for 130 logical pixels taller than the screen it is
//!   centred on. 1366×768 laptops fail identically at 100%. So the size in the
//!   config is not a size, it is a wish on a display nobody guaranteed.
//! - **Nothing clamped it.** `minWidth`/`minHeight` are floors, there is no
//!   ceiling, and no code asked the monitor how much room there was. `center`
//!   then split the overflow evenly, which is what put it off the *top* rather
//!   than only off the bottom.
//!
//! So this module grants the wish against the monitor it will actually land on,
//! and it runs before the window has ever been shown — `main` is
//! `"visible": false` in the config and `settle` is the only thing that shows
//! it. Sizing a window that is already on screen would be a visible jump on
//! exactly the machines this exists for, which is a worse bug to watch than the
//! one it fixes: the wrong answer, drawn, then corrected.
//!
//! Where it was when you closed it is remembered (`frame_of`, and `store`'s
//! `window_frame`), so a machine that needs a smaller window is asked to accept
//! one once rather than every launch.

use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewWindow, Window,
};

/// A window's outer rectangle, in **physical** pixels.
///
/// Physical rather than logical everywhere in this file, and that is the whole
/// of the bug above stated as a rule: monitors are described to us in physical
/// pixels, so a window rectangle compared against one has to be in the same
/// unit or the comparison is a coincidence that holds at 100% scaling and
/// nowhere else. It also means a stored frame survives the scale factor
/// changing between launches — 1280 physical pixels is the same piece of glass
/// whatever Windows is doing with DPI that day, where 1280 logical is not.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Frame {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
    pub maximized: bool,
}

/// The usable rectangle of one monitor, in physical pixels: the screen less the
/// taskbar. The work area rather than the full monitor size, because a window
/// sized to the whole screen has its bottom edge under the taskbar, and on this
/// wall the bottom edge is where the composer sits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Area {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

/// Shrink and shift a frame until it is inside a work area.
///
/// The order matters and is the reachability rule: the size is capped first,
/// then the far edge is pulled in, then the near edge — so a frame that cannot
/// fit loses its bottom-right rather than its top-left. Losing the bottom-right
/// of this window costs the end of a transcript, which scrolls; losing the
/// top-left costs the title bar, which is the only thing that can move the
/// window, and with `decorations: false` there is nothing behind it.
pub(crate) fn fit(frame: Frame, area: Area) -> Frame {
    let w = frame.w.min(area.w);
    let h = frame.h.min(area.h);
    let x = frame
        .x
        .min(area.x + area.w as i32 - w as i32)
        .max(area.x);
    let y = frame
        .y
        .min(area.y + area.h as i32 - h as i32)
        .max(area.y);
    Frame { x, y, w, h, ..frame }
}

/// Fit a frame and put it in the middle of the area, which is what a first
/// launch on an unknown screen wants.
pub(crate) fn centre(frame: Frame, area: Area) -> Frame {
    let f = fit(frame, area);
    Frame {
        x: area.x + (area.w as i32 - f.w as i32) / 2,
        y: area.y + (area.h as i32 - f.h as i32) / 2,
        ..f
    }
}

/// Place the studio window and show it. Call once, from `setup`.
///
/// `saved` is the frame from the last run, if there is one and it parsed.
pub fn settle<R: Runtime>(app: &AppHandle<R>, saved: Option<Frame>) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    place(&win, saved);
    /* Who has the keyboard right now, asked *before* the show, because the show
       is what takes it away from them. `None` unless we mean to give it back —
       see `opens_quietly`. */
    let interrupted = opens_quietly().then(foreground).flatten();
    /* Unconditionally, and this is the one line here that must not be allowed
       to become conditional: every failure above leaves a window in the wrong
       place, which you can drag, while a `show` that got skipped leaves an app
       with no window at all and no gesture that asks for one. */
    let _ = win.show();
    /* So the quiet open is a *return* of the foreground rather than a refusal to
       take it, and the guarantee above survives untouched. */
    if let Some(prev) = interrupted {
        hand_back(&win, prev);
    }
}

/// Should the studio open without taking the foreground?
///
/// A wall with the control surface armed is a wall being driven from outside —
/// `bun run lab`, `bun run test:wall` — and neither is something you are looking
/// at when it starts. It still opens, at full size, un-minimised, exactly where
/// it was placed; it simply does not interrupt what you were already typing
/// into. A dev instance that steals focus on every rebuild is a dev instance you
/// stop starting.
///
/// Gated on `SKEIN_CONTROL` rather than on a third flag of its own, deliberately:
/// arming the control surface is already an explicit gesture that lights a chip
/// in the title bar, and a *driven* wall taking the keyboard is unwanted in every
/// case rather than in some. The real studio, started by hand, is asking to be
/// looked at and still comes to the front.
fn opens_quietly() -> bool {
    crate::control::asked_for()
}

/// The window that had the keyboard, or `None` when nothing did.
#[cfg(windows)]
fn foreground() -> Option<isize> {
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    let h = unsafe { GetForegroundWindow() };
    (!h.is_invalid()).then(|| h.0 as isize)
}

#[cfg(not(windows))]
fn foreground() -> Option<isize> {
    None
}

/// Send the studio to the back of the z-order and give the keyboard back.
///
/// Two calls, because they are two separate facts and either alone leaves half
/// the disturbance: `SetWindowPos` with `SWP_NOACTIVATE` fixes where the window
/// sits without activating it, and `SetForegroundWindow` returns the focus the
/// `show` above has already taken. Windows only lets a process hand the
/// foreground away while it *is* the foreground, which is exactly where the show
/// has just left us standing — so the order here is the thing that makes it
/// work, not a preference.
///
/// Failure is silent and harmless throughout: what you get is the old
/// behaviour, a window at the front, which is where every other app's would be.
#[cfg(windows)]
fn hand_back<R: Runtime>(win: &WebviewWindow<R>, prev: isize) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        SetForegroundWindow, SetWindowPos, HWND_BOTTOM, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    };
    let Ok(ours) = win.hwnd() else { return };
    /* Our own window having been the foreground is not a thing to restore: it
       would mean handing the keyboard back to the window we are trying to move
       out of the way. */
    if prev == ours.0 as isize {
        return;
    }
    unsafe {
        let _ = SetWindowPos(
            ours,
            Some(HWND_BOTTOM),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
        let _ = SetForegroundWindow(HWND(prev as *mut core::ffi::c_void));
    }
}

#[cfg(not(windows))]
fn hand_back<R: Runtime>(_win: &WebviewWindow<R>, _prev: isize) {}

fn place<R: Runtime>(win: &WebviewWindow<R>, saved: Option<Frame>) {
    let wanted = match saved {
        Some(f) => f,
        None => {
            /* The config's own size, already through the scale factor, read off
               the window rather than restated here — one number for it, and it
               lives where a person editing the app expects to find it. */
            let Ok(size) = win.outer_size() else { return };
            Frame { x: 0, y: 0, w: size.width, h: size.height, maximized: false }
        }
    };

    /* Which monitor: the one under the middle of the frame we are about to
       draw, so a window restored onto a second screen stays there. A saved
       frame whose monitor has since been unplugged finds nothing and falls back
       to the primary — which is the case that has to work, since the alternative
       is a window on a desk that is no longer connected. */
    let centre_of = (
        wanted.x as f64 + wanted.w as f64 / 2.0,
        wanted.y as f64 + wanted.h as f64 / 2.0,
    );
    let monitor = match saved {
        Some(_) => win.monitor_from_point(centre_of.0, centre_of.1).ok().flatten(),
        None => win.current_monitor().ok().flatten(),
    }
    .or_else(|| win.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else { return };

    let wa = monitor.work_area();
    let area = Area { x: wa.position.x, y: wa.position.y, w: wa.size.width, h: wa.size.height };

    /* A remembered frame is honoured where it is; a first launch is centred.
       Both go through `fit`, so a screen that shrank since last time — a
       projector unplugged, a scale factor raised — is caught on the way in. */
    let f = match saved {
        Some(_) => fit(wanted, area),
        None => centre(wanted, area),
    };

    /* Position before size. Moving a window between monitors of different DPI
       makes Windows resize it to keep its logical size, so a size set first can
       be overwritten by the move that follows it; a size set last cannot. */
    let _ = win.set_position(PhysicalPosition::new(f.x, f.y));
    let _ = win.set_size(PhysicalSize::new(f.w, f.h));
    if f.maximized {
        let _ = win.maximize();
    }
}

/// Where the window is now, to be given back to `settle` next launch.
///
/// `None` means "do not record this one", and both cases that returns for are
/// real states a window is closed from rather than defensive noise:
///
/// - **Minimized.** Windows parks a minimized window at (-32000, -32000), and
///   that is what `outer_position` reports — a frame on no monitor, which the
///   next launch would have to rescue rather than restore.
/// - **A zero dimension**, which no window a person can see has.
///
/// Maximized is recorded as a flag beside the frame, not instead of it: the
/// frame under a maximized window is the work area, so restoring it and then
/// maximizing lands in the same place, and a machine where that arithmetic is
/// off by a border still gets a frame `fit` has already clamped.
pub fn frame_of<R: Runtime>(win: &Window<R>) -> Option<Frame> {
    if win.is_minimized().unwrap_or(false) {
        return None;
    }
    let pos = win.outer_position().ok()?;
    let size = win.outer_size().ok()?;
    if size.width == 0 || size.height == 0 {
        return None;
    }
    Some(Frame {
        x: pos.x,
        y: pos.y,
        w: size.width,
        h: size.height,
        maximized: win.is_maximized().unwrap_or(false),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 1920×1080 at 150%: the desktop is 1280×720 and the taskbar takes ~32.
    /// This is the machine the bug was seen on.
    const SCALED: Area = Area { x: 0, y: 0, w: 1280, h: 688 };
    /// A 1920×1080 panel at 100%, taskbar included.
    const ROOMY: Area = Area { x: 0, y: 0, w: 1920, h: 1032 };

    fn frame(x: i32, y: i32, w: u32, h: u32) -> Frame {
        Frame { x, y, w, h, maximized: false }
    }

    #[test]
    fn a_window_taller_than_the_screen_is_cut_to_it() {
        let f = centre(frame(0, 0, 1280, 820), SCALED);
        assert_eq!((f.w, f.h), (1280, 688));
        /* And the top edge is on the screen, which is the whole point: this is
           the case that used to centre to y = -66 and take the title bar with
           it. */
        assert_eq!(f.y, 0);
    }

    #[test]
    fn a_window_that_fits_is_left_its_size_and_centred() {
        let f = centre(frame(0, 0, 1280, 820), ROOMY);
        assert_eq!((f.w, f.h), (1280, 820));
        assert_eq!((f.x, f.y), (320, 106));
    }

    #[test]
    fn the_work_area_origin_is_respected() {
        /* A taskbar on the left, or a second monitor above and to the left of
           the primary — the area does not start at the origin, and a clamp that
           assumed it did would push the window under the taskbar. */
        let area = Area { x: -1920, y: -200, w: 1280, h: 688 };
        let f = centre(frame(0, 0, 1280, 820), area);
        assert_eq!((f.x, f.y), (-1920, -200));
        let g = fit(frame(-3000, -900, 1280, 820), area);
        assert_eq!((g.x, g.y), (-1920, -200));
    }

    #[test]
    fn a_frame_off_the_bottom_right_is_pulled_back_in() {
        let f = fit(frame(1800, 1000, 1280, 820), ROOMY);
        assert_eq!((f.x, f.y), (1920 - 1280, 1032 - 820));
        assert_eq!((f.w, f.h), (1280, 820));
    }

    #[test]
    fn a_frame_that_already_fits_is_not_moved() {
        let f = frame(100, 50, 1280, 820);
        assert_eq!(fit(f, ROOMY), f);
    }

    #[test]
    fn maximized_survives_the_clamp() {
        let f = fit(Frame { maximized: true, ..frame(0, 0, 4000, 4000) }, SCALED);
        assert!(f.maximized);
        assert_eq!((f.w, f.h), (1280, 688));
    }
}
