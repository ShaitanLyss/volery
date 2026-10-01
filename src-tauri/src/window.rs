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
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewWindow, Window,
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
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

// ── every screen at once ───────────────────────────────────────────────────
//
// One window over the bounding box of every monitor, so the wall is a single
// surface you pan across desks rather than one wall per screen. It is the
// quick shape of the idea and its two costs are known and taken on purpose:
//
// - **A window has one DPI.** Spread over a 100% and a 150% screen, the wall is
//   drawn at whichever one Windows assigns, so it is the right size on one and
//   2/3 or 3/2 of it on the other. Continuous at the seam in pixels, not in
//   size. The shape that fixes that is N clipped views in one window, each
//   zoomed for its own monitor — a much larger change to `Canvas.svelte`.
// - **The box is a box and desks are not.** Monitors arranged in an L leave
//   corners of the window no screen shows; anything placed there is invisible.
//
// The chrome stays on the monitor the window was on when it spread — `home`,
// handed to the front end so it can pin the header, panel and dock there.

/// While the wall is spread, the frame to go back to and the box it covers.
#[derive(Default)]
pub struct Span(std::sync::Mutex<Option<Spread>>);

#[derive(Debug, Clone, Copy)]
struct Spread {
    /// The *normal* frame from before the spread — un-maximised first if it
    /// was maximised, with the flag kept — so going back restores both the
    /// maximise and the size an un-maximise would then return to.
    was: Frame,
    union: Area,
    /// Kept rather than asked again: a window already over the union has no
    /// "current monitor" worth the name, and on a desk of three equal screens
    /// `MonitorFromRect` is a three-way tie.
    home: Area,
    /// The home screen's scale factor — what the page is zoomed to render at.
    home_scale: f64,
    /// Whether the window could be resized before, to give it back.
    resizable: bool,
    /// Puts-back in the current burst, and when the last one was. A budget per
    /// *burst* rather than per spread: two things each insisting on a different
    /// rectangle is a loop at the speed of the message pump, but a display
    /// waking an hour later is a new disturbance and deserves a fresh one.
    holds: u32,
    last_hold: Option<std::time::Instant>,
}

const MAX_HOLDS: u32 = 8;
const BURST: std::time::Duration = std::time::Duration::from_secs(1);

/// What the front end needs to lay itself out over a spread window, all in
/// physical pixels relative to the window's *client* top-left — which is CSS 0,
/// and is the outer top-left only while there is no frame or shadow around it.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SpanView {
    pub home: Area,
    pub screens: Vec<Area>,
    /// The client area's size, so the home screen's far insets can be worked
    /// out exactly rather than off `innerWidth`, which the page rounds.
    pub client: (u32, u32),
    /// How far the client origin moved to spread, old minus new, so the wall
    /// can be panned to stay where it was on the glass rather than jumping a
    /// screen's width.
    pub shift: (i32, i32),
    /// The page's device pixel ratio once spread — the home screen's scale when
    /// the counter-zoom took, the window's own otherwise. What every physical
    /// figure above divides by.
    pub scale: f64,
}

/// Zoom the page so it renders at the home screen's scale whatever DPI Windows
/// gave the window — returns the device pixel ratio the page now has.
///
/// A window has one DPI, and Windows gives a spread window the DPI of whichever
/// monitor holds the most of it. On a desk of three equal screens that is a
/// tie, and when the 150% laptop won it every 100% screen was drawn half again
/// as large — spreading changed the size of everything, which it must not.
/// The webview's zoom multiplies the rasterisation scale, so `home / window`
/// puts `devicePixelRatio` back at the home screen's own and everything on it
/// exactly where and as big as it was. Unused otherwise: Tauri leaves the zoom
/// hotkeys off, and ctrl+0 is the transcript's (`App.svelte`).
fn rezoom<R: Runtime>(window: &Window<R>, home_scale: f64) -> f64 {
    let own = window.scale_factor().unwrap_or(1.0);
    let Some(view) = window.app_handle().get_webview_window(window.label()) else { return own };
    match view.set_zoom(home_scale / own) {
        Ok(()) => home_scale,
        Err(_) => own,
    }
}

fn unzoom<R: Runtime>(window: &Window<R>) {
    if let Some(view) = window.app_handle().get_webview_window(window.label()) {
        let _ = view.set_zoom(1.0);
    }
}

/// The smallest rectangle holding every area. `None` for none.
pub(crate) fn union(areas: &[Area]) -> Option<Area> {
    let first = areas.first()?;
    let (mut l, mut t) = (first.x, first.y);
    let (mut r, mut b) = (first.x + first.w as i32, first.y + first.h as i32);
    for a in &areas[1..] {
        l = l.min(a.x);
        t = t.min(a.y);
        r = r.max(a.x + a.w as i32);
        b = b.max(a.y + a.h as i32);
    }
    Some(Area { x: l, y: t, w: (r - l) as u32, h: (b - t) as u32 })
}

/// `a` restated relative to the point `(x, y)`.
pub(crate) fn within(a: Area, x: i32, y: i32) -> Area {
    Area { x: a.x - x, y: a.y - y, ..a }
}

/// A monitor's whole glass rather than its work area: spread, the window
/// covers the taskbars too, so the wall is all there is to see.
fn glass(m: &tauri::Monitor) -> Area {
    let (p, s) = (m.position(), m.size());
    Area { x: p.x, y: p.y, w: s.width, h: s.height }
}

fn screens_of<R: Runtime>(window: &Window<R>) -> Vec<Area> {
    window.available_monitors().map(|ms| ms.iter().map(glass).collect()).unwrap_or_default()
}

/// Spread the studio over every screen, or put it back where it was.
///
/// Returns the layout to draw against while spread, `None` once it is not.
/// Not `async`: everything here is a window call that answers at once, and
/// `SetWindowPos` has to run on the thread that owns the window anyway.
#[tauri::command]
pub fn span_screens(
    window: Window,
    span: tauri::State<'_, Span>,
    on: bool,
) -> Result<Option<SpanView>, String> {
    /* The lock is never held across anything that moves or restyles the window.
       `SetWindowPos`, `ShowWindow` and the shadow/resizable setters all deliver
       `Moved`/`Resized` synchronously, on this thread, and the handler for those
       is `hold` — which takes this same lock (with `try_lock`, so the cost of a
       slip would be a missed hold rather than a frozen app, but still). */
    let prior = *span.0.lock().map_err(|e| e.to_string())?;
    if !on {
        let Some(s) = prior else { return Ok(None) };
        *span.0.lock().map_err(|e| e.to_string())? = None;
        unspread(&window, s);
        return Ok(None);
    }

    let screens = screens_of(&window);
    let all = union(&screens).ok_or("no screens to spread over")?;
    let before = window.inner_position().map_err(|e| e.to_string())?;

    let spread = match prior {
        /* Pressed twice, or a front end that reloaded and asked again: the
           frame to return to is the one from before the *first* spread, and the
           home screen is the one it was spread from. */
        Some(s) => Spread { union: all, holds: 0, last_hold: None, ..s },
        None => {
            /* Home is where the window is now, read before it moves — that is
               the screen you pressed the button on, so it is where the chrome
               is expected to stay. */
            let here = window.current_monitor().ok().flatten();
            let home = here.as_ref().map(glass).unwrap_or(screens[0]);
            let home_scale = here.as_ref().map(|m| m.scale_factor()).unwrap_or(1.0);
            let maximized = window.is_maximized().unwrap_or(false);
            if maximized {
                /* So `frame_of` reads the size an un-maximise returns to, not
                   the work area: restoring the maximise later over that frame
                   would otherwise make the work area the normal size too. */
                restore_normal(&window);
            }
            let normal = frame_of(&window).ok_or("the window is minimised")?;
            Spread {
                was: Frame { maximized, ..normal },
                union: all,
                home,
                home_scale,
                resizable: window.is_resizable().unwrap_or(true),
                holds: 0,
                last_hold: None,
            }
        }
    };

    /* Before the state is stored, so the frame change each one causes is not
       mistaken by `hold` for something to correct. Both, because each closes
       half of the same hole: with the shadow on, tao's `WM_NCCALCSIZE` keeps an
       inset band (≈8px physical at 100%) around an undecorated window, which
       showed the desktop through at every outer edge and moved the client
       origin off the outer one; and a resizable window keeps its edges
       hit-testing as resize borders even without it, so a press at the edge of
       a screen started a modal resize of the whole spread. */
    let _ = window.set_shadow(false);
    let _ = window.set_resizable(false);
    *span.0.lock().map_err(|e| e.to_string())? = Some(spread);

    cover(&window, all);
    mark_fullscreen(&window, true);
    let scale = rezoom(&window, spread.home_scale);

    /* Measured from where the client actually is rather than from `all`, so a
       window that came out a few pixels off its box is still described
       truthfully — the front end lays out against CSS 0, which is this. */
    let origin = window.inner_position().map_err(|e| e.to_string())?;
    let client = window.inner_size().map_err(|e| e.to_string())?;
    Ok(Some(SpanView {
        home: within(spread.home, origin.x, origin.y),
        screens: screens.into_iter().map(|s| within(s, origin.x, origin.y)).collect(),
        client: (client.width, client.height),
        shift: (before.x - origin.x, before.y - origin.y),
        scale,
    }))
}

/// Undo a spread whose state has already been taken out of `Span`.
///
/// The frame goes back through `fit`, against the monitor under its middle or
/// failing that the primary, for the reason this whole file exists: the frame
/// is from before the spread, and the screen it was on may since have been
/// unplugged — which is one of the two ways a spread ends without being asked.
fn unspread<R: Runtime>(window: &Window<R>, s: Spread) {
    mark_fullscreen(window, false);
    unzoom(window);
    let _ = window.set_shadow(true);
    let _ = window.set_resizable(s.resizable);
    let centre = (s.was.x as f64 + s.was.w as f64 / 2.0, s.was.y as f64 + s.was.h as f64 / 2.0);
    let monitor = window
        .monitor_from_point(centre.0, centre.1)
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());
    let f = match monitor {
        Some(m) => {
            let wa = m.work_area();
            fit(s.was, Area { x: wa.position.x, y: wa.position.y, w: wa.size.width, h: wa.size.height })
        }
        None => s.was,
    };
    cover(window, Area { x: f.x, y: f.y, w: f.w, h: f.h });
    if f.maximized {
        let _ = window.maximize();
    }
}

/// Put a spread window back over its box if something moved it — or let the
/// spread go, if what moved it was the screens themselves.
///
/// What moves it is mostly Windows: a DPI change makes tao rescale the window
/// by the ratio of the two scale factors (`WM_DPICHANGED` in tao's
/// `event_loop.rs`), which on a 100%/150% desk turns the box into one half
/// again as large in each direction. Also Win+arrow, and a display waking.
///
/// **Deferred by way of another thread, and that is not decoration.**
/// `run_on_main_thread` called *on* the main thread runs the closure inline
/// (`tauri-runtime-wry`'s `send_user_message` short-circuits when it is already
/// there), and this is called from inside the very event that moved the window
/// — where tao has yet to apply its own size. Posted from elsewhere, it queues
/// behind the message being handled, which is the whole of what "after" means.
pub fn hold<R: Runtime>(window: &Window<R>) {
    let Some(span) = window.try_state::<Span>() else { return };
    /* `try_lock`, because this runs inside window events and the toggle may
       hold the lock on this thread: busy means the toggle is placing the window
       itself, and there is nothing to hold it to yet. */
    let spread = match span.0.try_lock() {
        Ok(g) => g.is_some(),
        Err(_) => false,
    };
    if !spread {
        return;
    }
    let w = window.clone();
    std::thread::spawn(move || {
        let inner = w.clone();
        let _ = w.run_on_main_thread(move || reassert(&inner));
    });
}

fn reassert<R: Runtime>(w: &Window<R>) {
    if w.is_minimized().unwrap_or(false) {
        /* A minimised window sits at (-32000, -32000); putting it back over the
           box would un-minimise it behind your back. */
        return;
    }
    let Some(span) = w.try_state::<Span>() else { return };
    let screens = screens_of(w);
    enum Then {
        Nothing,
        Cover(Area),
        Lose(Spread),
    }
    let then = {
        let Ok(mut g) = span.0.lock() else { return };
        let Some(s) = g.as_mut() else { return };
        if union(&screens).is_some_and(|u| u != s.union) {
            /* The desk changed under a spread — undocked, a lid closed, a
               monitor slept for good. The old box is wrong and so is the home
               screen the chrome is pinned to, which may be glass that no longer
               exists, and with it the only button that ends the spread. So it
               ends here instead, and the front end is told. */
            let s = *s;
            *g = None;
            Then::Lose(s)
        } else {
            let now = std::time::Instant::now();
            if s.last_hold.is_none_or(|t| now.duration_since(t) > BURST) {
                s.holds = 0;
            }
            let on_it = frame_of(w).is_some_and(|f| {
                !f.maximized && (f.x, f.y, f.w, f.h) == (s.union.x, s.union.y, s.union.w, s.union.h)
            });
            if on_it || s.holds >= MAX_HOLDS {
                Then::Nothing
            } else {
                s.holds += 1;
                s.last_hold = Some(now);
                Then::Cover(s.union)
            }
        }
    };
    match then {
        /* The zoom is put right on every pass, the quiet ones included: a DPI
           change that leaves the window exactly over its box is still a page
           now drawn at the wrong scale. */
        Then::Nothing => {
            if let Some(s) = span.0.lock().ok().and_then(|g| *g) {
                rezoom(w, s.home_scale);
            }
        }
        Then::Cover(a) => {
            cover(w, a);
            if let Some(s) = span.0.lock().ok().and_then(|g| *g) {
                rezoom(w, s.home_scale);
            }
        }
        Then::Lose(s) => {
            unspread(w, s);
            let _ = w.emit("window:spread", Option::<SpanView>::None);
        }
    }
}

/// The frame worth remembering for the next launch: the one from before the
/// spread, if there is one, since opening a fresh window over every screen is
/// not something a restart should do on its own.
pub fn frame_to_keep<R: Runtime>(window: &Window<R>) -> Option<Frame> {
    let spread = window.try_state::<Span>().and_then(|s| s.0.lock().ok().and_then(|g| *g));
    spread.map(|s| s.was).or_else(|| frame_of(window))
}

/// Un-maximise synchronously, so the frame read next is the normal one.
/// Win32 rather than tauri's `unmaximize`, so that the read which follows
/// cannot race a request still in a queue.
#[cfg(windows)]
fn restore_normal<R: Runtime>(win: &Window<R>) {
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_RESTORE};
    if let Ok(h) = win.hwnd() {
        unsafe {
            let _ = ShowWindow(h, SW_RESTORE);
        }
    }
}

#[cfg(not(windows))]
fn restore_normal<R: Runtime>(win: &Window<R>) {
    let _ = win.unmaximize();
}

/// Place the window's outer rectangle exactly, in one call.
///
/// Win32 rather than tauri's `set_position` + `set_size`, because those are two
/// moves and the first can land the window on a monitor of another DPI, which
/// rescales it before the second arrives. One `SetWindowPos` is one decision.
/// A DPI change it does cause is handled synchronously inside it, by tao,
/// resizing the window — so the result is read back and the call repeated; the
/// second time the window is already at the DPI that rectangle earns, and it
/// sticks.
#[cfg(windows)]
fn cover<R: Runtime>(win: &Window<R>, a: Area) {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowRect, IsZoomed, SetWindowPos, ShowWindow, SWP_NOACTIVATE, SWP_NOOWNERZORDER,
        SWP_NOZORDER, SW_RESTORE,
    };
    let Ok(h) = win.hwnd() else { return };
    unsafe {
        /* A maximised window keeps its maximised state through a SetWindowPos,
           and Windows then puts it back over one monitor at the next chance. */
        if IsZoomed(h).as_bool() {
            let _ = ShowWindow(h, SW_RESTORE);
        }
        for _ in 0..3 {
            let _ = SetWindowPos(
                h,
                None,
                a.x,
                a.y,
                a.w as i32,
                a.h as i32,
                SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
            );
            let mut r = RECT::default();
            if GetWindowRect(h, &mut r).is_ok()
                && (r.left, r.top, r.right - r.left, r.bottom - r.top)
                    == (a.x, a.y, a.w as i32, a.h as i32)
            {
                return;
            }
        }
    }
}

#[cfg(not(windows))]
fn cover<R: Runtime>(win: &Window<R>, a: Area) {
    let _ = win.set_position(PhysicalPosition::new(a.x, a.y));
    let _ = win.set_size(PhysicalSize::new(a.w, a.h));
}

/// Tell the shell this window is full-screen, so the taskbars go under it
/// while it has the foreground.
///
/// The shell would usually work that out from a window covering a monitor
/// exactly, but that rule is about one window and one monitor, and this window
/// covers several and matches none of their rectangles. The hint is explicit.
/// **Unverified on more than one taskbar**: the shell may decide per monitor by
/// `MonitorFromWindow`, which names one screen for a window over three, so the
/// taskbars on the others may stay on top. If they do, topmost-while-focused is
/// the next thing to try. Failure is otherwise harmless — the wall is simply
/// under the taskbars.
#[cfg(windows)]
fn mark_fullscreen<R: Runtime>(win: &Window<R>, on: bool) {
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
    use windows::Win32::UI::Shell::{ITaskbarList2, TaskbarList};
    let Ok(h) = win.hwnd() else { return };
    unsafe {
        let Ok(list) = CoCreateInstance::<_, ITaskbarList2>(&TaskbarList, None, CLSCTX_INPROC_SERVER)
        else {
            return;
        };
        if list.HrInit().is_err() {
            return;
        }
        let _ = list.MarkFullscreenWindow(h, on);
    }
}

#[cfg(not(windows))]
fn mark_fullscreen<R: Runtime>(_win: &Window<R>, _on: bool) {}

#[cfg(test)]
mod tests {
    use super::*;

    /// Lyss's desk, read off `EnumDisplayMonitors` on 2026-10-01: a portrait
    /// screen left of the primary, and a 150% laptop under it.
    const PORTRAIT: Area = Area { x: -1200, y: -16, w: 1200, h: 1920 };
    const PRIMARY: Area = Area { x: 0, y: 0, w: 1920, h: 1200 };
    const BELOW: Area = Area { x: 0, y: 1200, w: 1920, h: 1200 };

    #[test]
    fn the_union_is_the_box_around_every_screen() {
        let u = union(&[PRIMARY, BELOW, PORTRAIT]).unwrap();
        assert_eq!(u, Area { x: -1200, y: -16, w: 3120, h: 2416 });
        assert_eq!(union(&[]), None);
        assert_eq!(union(&[PRIMARY]), Some(PRIMARY));
    }

    #[test]
    fn home_is_restated_from_the_box_origin() {
        let u = union(&[PRIMARY, BELOW, PORTRAIT]).unwrap();
        /* The primary starts 16px below the portrait's top edge, which is the
           sliver of window above it no screen shows. */
        assert_eq!(within(PRIMARY, u.x, u.y), Area { x: 1200, y: 16, w: 1920, h: 1200 });
        assert_eq!(within(PORTRAIT, u.x, u.y), Area { x: 0, y: 0, w: 1200, h: 1920 });
    }

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
