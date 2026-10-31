//! Driving this laptop through its own tile, with Volery staying in front — and
//! the keyboard hook that lets go of a screen, which the focused remote screen
//! shares.
//!
//! Windows has one cursor and one foreground window, and Volery covers the app
//! a local tile shows. `examples/drive-probe.rs` measured the way through, and
//! its header has every number; the shape that came out of it:
//!
//! - **While driving, Volery is `HWND_TOPMOST` and wears `WS_EX_TRANSPARENT`
//!   and `WS_EX_NOACTIVATE`.** Topmost keeps it drawn over the app that has
//!   the foreground. `WS_EX_TRANSPARENT` *alone* is not click-through (Volery
//!   still owns its clicks) but it stops Chromium counting Volery as a cover:
//!   without it Edge, Chrome and every Electron app under Volery paint nothing
//!   (0 rAF/s, `visibilityState` hidden) and the tile freezes while you type
//!   into it. `WS_EX_NOACTIVATE` is the tile click not taking the foreground
//!   back from the app it is driving — the probe saw that click blur the app
//!   every time, and the style can be set from any thread, where a subclass
//!   answering `WM_MOUSEACTIVATE` would have to be installed on the main one.
//! - **A click is one instant of click-through.** `WS_EX_LAYERED` joins
//!   `WS_EX_TRANSPARENT` (which is what passes a click), one `SendInput` batch
//!   of [move to P, down, up, move back], a wait until the cursor is back —
//!   which proves the press has been hit-tested — and the layered style comes
//!   off. No composed frame changed while the probe did it; the cursor is away
//!   ~24 ms, a blink at 240 Hz that is accepted (`docs/SCREENS.md`).
//! - **A press is replayed when it ends**, as a click or as a drag along the
//!   path the pointer took: the physical button is on Volery's window, so the
//!   app can only be handed the whole gesture. Double clicks work (two clicks
//!   at one point inside the double-click time), hover and press-and-hold do
//!   not.
//! - **The wheel moves no cursor at all**: a `WM_MOUSEWHEEL` sent to the window
//!   under P while Volery lets it through for the millisecond it takes.
//! - **Keys are not sent.** The app has the foreground, so the physical
//!   keyboard reaches it natively, IME and dead keys and all.
//!
//! Getting out is what Lyss chose for every screen: **hold Escape for 500 ms**
//! (a tap still reaches the app), or click outside the tile. Volery never sees
//! the Escape — the app has the keyboard — so a `WH_KEYBOARD_LL` hook (`Hold`)
//! is installed for exactly as long as the drive. It turns a hold into
//! leaving, replays a tap, and tells the tile `{"t":"hold","phase":…}` so it
//! can draw the ring it cannot hear the key for. The focused remote screen
//! uses the same hook in its other mode, `Keys::Capture`, where every key goes
//! to the far machine — Win, Alt+Tab, Alt+F4, Ctrl+Esc included — instead of
//! to this one.
//!
//! Nothing here runs on the main thread: gestures on a thread of their own,
//! the hook on another with its own message loop.

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};

use super::inject::{to_pixel, Rect};
use super::{Button, Input, Monitor, Out, Viewer};

/* ── gestures, pure ────────────────────────────────────────────────────── */

/// What the app under the tile is handed, in desktop pixels.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Gesture {
    Click { button: Button, at: (i32, i32) },
    /// A press that travelled: down at the first point, up at the last.
    Drag { button: Button, path: Vec<(i32, i32)> },
    Wheel { at: (i32, i32), delta: i32, horizontal: bool },
}

/// How many points of a drag are replayed. Enough for a text selection to
/// follow the pointer's line; few enough that the replay stays short, since
/// Volery is click-through for all of it.
const MAX_PATH: usize = 24;

/// The pointer's state between a press and its release.
#[derive(Debug, Default)]
pub struct Presses {
    at: Option<(u16, u16)>,
    down: Option<(Button, Vec<(i32, i32)>)>,
}

/// A press is a click until it has travelled further than this share of the
/// monitor's width — 1%, ~25 px on a 2560 panel, which is the house's 4 px
/// slop on a tile drawn at a quarter of the monitor's size.
fn slop(mon: Rect) -> i32 {
    (mon.w / 100).max(4)
}

fn thin(path: &mut Vec<(i32, i32)>) {
    if path.len() <= MAX_PATH {
        return;
    }
    let last = *path.last().unwrap();
    let mut keep: Vec<(i32, i32)> = path.iter().step_by(2).copied().collect();
    if keep.last() != Some(&last) {
        keep.push(last);
    }
    *path = keep;
}

impl Presses {
    pub fn fold(&mut self, e: &Input, mon: Rect, out: &mut Vec<Gesture>) {
        match *e {
            Input::MouseAbs { x, y } => {
                self.at = Some((x, y));
                if let Some((_, path)) = &mut self.down {
                    let p = to_pixel(x, y, mon);
                    if path.last() != Some(&p) {
                        path.push(p);
                        thin(path);
                    }
                }
            }
            Input::Button { button, down: true } => {
                // one gesture at a time; a press with no position is nowhere
                if self.down.is_none() {
                    if let Some((x, y)) = self.at {
                        self.down = Some((button, vec![to_pixel(x, y, mon)]));
                    }
                }
            }
            Input::Button { button, down: false } => {
                if matches!(&self.down, Some((b, _)) if *b == button) {
                    let (button, path) = self.down.take().unwrap();
                    let first = path[0];
                    let far = path
                        .iter()
                        .any(|p| (p.0 - first.0).abs() > slop(mon) || (p.1 - first.1).abs() > slop(mon));
                    out.push(if far { Gesture::Drag { button, path } } else { Gesture::Click { button, at: first } });
                }
            }
            Input::Wheel { dx, dy } => {
                if let Some((x, y)) = self.at {
                    let at = to_pixel(x, y, mon);
                    if dy != 0 {
                        out.push(Gesture::Wheel { at, delta: dy as i32, horizontal: false });
                    }
                    if dx != 0 {
                        out.push(Gesture::Wheel { at, delta: dx as i32, horizontal: true });
                    }
                }
            }
            // the press that never ended is dropped, not replayed
            Input::ReleaseAll => self.down = None,
            // the keyboard is the app's natively; relative motion moves nothing here
            Input::Key { .. } | Input::MouseRel { .. } => {}
        }
    }
}

/* ── the Escape hold, pure ─────────────────────────────────────────────── */

/// How long Escape must be held to let go of a screen — Lyss's number, the
/// same as the front's own for a screen Volery can hear the key for.
pub const HOLD_MS: u32 = 500;

/// What the hook does with one Escape event.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Esc {
    /// Swallow it, tell the tile the ring starts, start the timer.
    Start,
    /// Swallow it; the timer is running or the hold is already done.
    Absorb,
    /// Swallow the release, tell the tile the ring is cancelled, and replay a
    /// whole Escape to wherever it was going: it was a tap.
    Tap,
    /// Swallow the release of a hold that already let go.
    End,
}

#[derive(Debug, Default)]
pub struct EscHold {
    held: bool,
    done: bool,
}

impl EscHold {
    pub fn key(&mut self, down: bool) -> Esc {
        match (down, self.held) {
            (true, false) => {
                self.held = true;
                self.done = false;
                Esc::Start
            }
            (true, true) => Esc::Absorb,
            (false, true) => {
                self.held = false;
                if self.done {
                    Esc::End
                } else {
                    Esc::Tap
                }
            }
            // an up for a press the hook never saw (installed mid-press): let it be
            (false, false) => Esc::End,
        }
    }

    /// The timer fired. True exactly once per hold, if it is still held.
    pub fn timer(&mut self) -> bool {
        if self.held && !self.done {
            self.done = true;
            true
        } else {
            false
        }
    }
}

const VK_ESCAPE: u32 = 0x1b;
const VK_PAUSE: u32 = 0x13;
const VK_NUMLOCK: u32 = 0x90;
const VK_SNAPSHOT: u32 = 0x2c;

/// A key as the hook hears it → the wire's scancode (`src/lib/castinput.ts`'s
/// numbering). None for what is not a key on a keyboard: the fake shifts and
/// the fake left Ctrl that AltGr sends on AZERTY carry a scancode above `0xff`
/// (`0x22A`, `0x21D`), and a code of 0 names nothing.
pub fn wire_scan(vk: u32, scan: u32, extended: bool) -> Option<u16> {
    match vk {
        VK_PAUSE => return Some(0xe11d),
        VK_NUMLOCK => return Some(0x45),
        VK_SNAPSHOT => return Some(0xe037),
        _ => {}
    }
    if scan == 0 || scan > 0xff {
        return None;
    }
    Some(scan as u16 | if extended { 0xe000 } else { 0 })
}

/* ── the hook ──────────────────────────────────────────────────────────── */

/// What happens to keys while the hook is in.
pub enum Keys {
    /// Local drive: every key goes where Windows sends it — the driven app —
    /// and only Escape is watched.
    Native,
    /// A focused remote screen: while Volery has the foreground, every key is
    /// taken off this machine and handed to `sink` as wire input, system keys
    /// included. Escape is still a tap or a hold.
    Capture(Arc<dyn Fn(&[Input]) + Send + Sync>),
}

/// What the hook's callback asks its worker to do. The callback itself only
/// decides: Windows removes a low-level hook that is slow to answer, without
/// saying so.
enum Ask {
    Phase(&'static str),
    Done,
    Tap,
    Keys(Vec<Input>),
}

struct HookState {
    capture: bool,
    volery: isize,
    esc: EscHold,
    timer: usize,
    asks: Sender<Ask>,
    /// What capture has handed the far machine and not yet lifted.
    down: BTreeSet<u16>,
}

static HOOK: Mutex<Option<HookState>> = Mutex::new(None);

/// The hook, installed. Dropping it takes it out, and in capture mode lifts on
/// the far machine whatever it had pressed there.
pub struct Hold {
    thread: u32,
    hook: Option<std::thread::JoinHandle<()>>,
    worker: Option<std::thread::JoinHandle<()>>,
}

/// Put the hook in. `volery` is the main window's `HWND`; `viewer` hears the
/// ring's phases; `on_done` runs on the worker when a hold lets go. Only one
/// hook at a time — a second is refused rather than stacked.
pub fn hold(
    keys: Keys,
    volery: isize,
    viewer: Arc<dyn Viewer>,
    on_done: Box<dyn Fn() + Send>,
) -> Result<Hold, String> {
    let (asks, rx) = mpsc::channel::<Ask>();
    let (capture, sink) = match keys {
        Keys::Native => (false, None),
        Keys::Capture(s) => (true, Some(s)),
    };
    {
        let mut h = HOOK.lock().unwrap();
        if h.is_some() {
            return Err("a screen already holds the keyboard".into());
        }
        *h = Some(HookState { capture, volery, esc: EscHold::default(), timer: 0, asks, down: BTreeSet::new() });
    }
    let worker = std::thread::Builder::new()
        .name("cast-hold".into())
        .spawn(move || {
            let say = |phase: &str| {
                viewer.send(Out::Text(format!(r#"{{"t":"hold","phase":"{phase}"}}"#).into()));
            };
            for ask in rx {
                match ask {
                    Ask::Phase(p) => say(p),
                    Ask::Done => {
                        say("done");
                        on_done();
                    }
                    Ask::Tap => match &sink {
                        Some(s) => s(&[Input::Key { scan: 0x01, down: true }, Input::Key { scan: 0x01, down: false }]),
                        None => os::replay_escape(),
                    },
                    Ask::Keys(k) => {
                        if let Some(s) = &sink {
                            s(&k);
                        }
                    }
                }
            }
        })
        .map_err(|e| e.to_string())?;
    let (ready_tx, ready_rx) = mpsc::channel();
    let hook = std::thread::Builder::new()
        .name("cast-hook".into())
        .spawn(move || os::hook_loop(ready_tx, !capture))
        .map_err(|e| e.to_string())?;
    match ready_rx.recv() {
        Ok(Ok(thread)) => Ok(Hold { thread, hook: Some(hook), worker: Some(worker) }),
        other => {
            // taking the state drops the worker's sender, so it runs dry
            HOOK.lock().unwrap().take();
            let _ = hook.join();
            let _ = worker.join();
            Err(match other {
                Ok(Err(e)) => format!("the keyboard hook could not be installed: {e}"),
                _ => "the keyboard hook's thread ended before it answered".into(),
            })
        }
    }
}

impl Drop for Hold {
    fn drop(&mut self) {
        os::stop_loop(self.thread);
        if let Some(h) = self.hook.take() {
            let _ = h.join();
        }
        // lift what capture pressed, then let the worker run dry
        if let Some(state) = HOOK.lock().unwrap().take() {
            if !state.down.is_empty() {
                let ups = state.down.iter().rev().map(|&scan| Input::Key { scan, down: false }).collect();
                let _ = state.asks.send(Ask::Keys(ups));
            }
        }
        if let Some(w) = self.worker.take() {
            let _ = w.join();
        }
    }
}

/// One key event, decided. Returns whether to swallow it. Runs inside the
/// hook's callback, under `HOOK`'s lock, so it does nothing but decide and
/// queue.
fn on_key(s: &mut HookState, vk: u32, scan: u32, extended: bool, down: bool, front: isize) -> bool {
    if s.capture && front != s.volery {
        // Volery is not in front: these keys are somebody else's
        return false;
    }
    if vk == VK_ESCAPE {
        match s.esc.key(down) {
            Esc::Start => {
                s.timer = os::start_timer();
                let _ = s.asks.send(Ask::Phase("down"));
            }
            Esc::Absorb => {}
            Esc::Tap => {
                os::stop_timer(s.timer);
                let _ = s.asks.send(Ask::Phase("up"));
                let _ = s.asks.send(Ask::Tap);
            }
            Esc::End => os::stop_timer(s.timer),
        }
        return true;
    }
    if !s.capture {
        return false;
    }
    if let Some(scan) = wire_scan(vk, scan, extended) {
        if down {
            s.down.insert(scan);
        } else if !s.down.remove(&scan) {
            // an up for a key pressed before the hook went in: Windows has it
            return false;
        }
        let _ = s.asks.send(Ask::Keys(vec![Input::Key { scan, down }]));
    }
    true
}

fn on_timer() {
    if let Some(s) = HOOK.lock().unwrap().as_mut() {
        os::stop_timer(s.timer);
        if s.esc.timer() {
            let _ = s.asks.send(Ask::Done);
        }
    }
}

/* ── the drive ─────────────────────────────────────────────────────────── */

static CONFIRMED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static GAVE_UP: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// How many clicks the mouse hook saw delivered before Volery closed up again,
/// and how many it gave up waiting for. A climbing second number is clicks
/// landing on Volery instead of the app — the one figure that says whether
/// [`os::settle`]'s bound is right on a given machine.
pub fn settles() -> (u64, u64) {
    (CONFIRMED.load(Ordering::Relaxed), GAVE_UP.load(Ordering::Relaxed))
}

struct Window {
    hwnd: isize,
    /// The extended style before the drive, put back after it.
    ex0: u32,
    left: AtomicBool,
}

impl Window {
    /// Put Volery back as it was, once. `activate` hands it the foreground
    /// too: right after a hold or a click outside the tile, which is somebody
    /// coming back to the wall; not when a session merely ended under them.
    fn leave(&self, activate: bool) {
        if self.left.swap(true, Ordering::SeqCst) {
            return;
        }
        os::restore(self.hwnd, self.ex0);
        if activate {
            os::activate(self.hwnd);
        }
    }
}

enum Job {
    Events(Vec<Input>, Rect),
}

/// This laptop, driven through its own tile. Made when the tile says
/// `{"t":"drive","on":true}`; [`Drive::leave`] when it says off; dropped when
/// the session ends.
pub struct Drive {
    win: Arc<Window>,
    mon: Rect,
    jobs: Option<Sender<Job>>,
    worker: Option<std::thread::JoinHandle<()>>,
    hold: Option<Hold>,
}

impl Drive {
    /// `volery` is the main window's `HWND`, `monitor` the local monitor the
    /// tile shows, `viewer` the tile's session (it hears the hold's phases).
    pub fn start(volery: isize, monitor: &Monitor, viewer: Arc<dyn Viewer>) -> Result<Drive, String> {
        let ex0 = os::enter(volery)?;
        let win = Arc::new(Window { hwnd: volery, ex0, left: AtomicBool::new(false) });
        let (jobs, rx) = mpsc::channel::<Job>();
        let w = win.clone();
        let worker = std::thread::Builder::new()
            .name("cast-drive".into())
            .spawn(move || {
                let mut presses = Presses::default();
                let mut gestures = Vec::new();
                for Job::Events(events, mon) in rx {
                    if w.left.load(Ordering::SeqCst) {
                        continue;
                    }
                    gestures.clear();
                    for e in &events {
                        presses.fold(e, mon, &mut gestures);
                    }
                    for g in &gestures {
                        os::perform(w.hwnd, w.ex0, g, &w.left);
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        let w = win.clone();
        let hold = match hold(Keys::Native, volery, viewer, Box::new(move || w.leave(true))) {
            Ok(h) => Some(h),
            Err(e) => {
                win.leave(false);
                return Err(e);
            }
        };
        Ok(Drive { win, mon: Rect::from(monitor), jobs: Some(jobs), worker: Some(worker), hold })
    }

    pub fn retarget(&mut self, monitor: &Monitor) {
        self.mon = Rect::from(monitor);
    }

    /// Pointer and wheel events off the tile, as `wire::read_inputs` gave
    /// them. Never blocks.
    pub fn apply(&self, events: &[Input]) {
        if let (false, Some(jobs)) = (events.is_empty(), &self.jobs) {
            let _ = jobs.send(Job::Events(events.to_vec(), self.mon));
        }
    }

    /// The tile let go: Volery is itself again and in front.
    pub fn leave(&mut self) {
        self.finish(true);
    }

    /// Put Volery back, then wait for a click still in flight and put it back
    /// again: that click's own closing-up may have run after the first
    /// restore. Idempotent.
    fn finish(&mut self, activate: bool) {
        self.win.leave(activate);
        self.hold.take();
        self.jobs.take();
        if let Some(w) = self.worker.take() {
            let _ = w.join();
            os::restore(self.win.hwnd, self.win.ex0);
        }
    }
}

impl Drop for Drive {
    fn drop(&mut self) {
        self.finish(false);
    }
}

/* ── Win32 ─────────────────────────────────────────────────────────────── */

#[cfg(windows)]
mod os {
    use super::super::inject::{to_virtual, MARK, MARK_LAST};
    use super::{Button, Gesture, Rect};
    use std::sync::atomic::Ordering;
    use std::sync::mpsc::Sender;
    use std::sync::{Condvar, Mutex};
    use std::time::{Duration, Instant};
    use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentProcessId, GetCurrentThreadId};
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_KEYUP,
        KEYEVENTF_SCANCODE, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
        MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN,
        MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_XDOWN, MOUSEEVENTF_XUP, MOUSEINPUT,
        MOUSE_EVENT_FLAGS, VIRTUAL_KEY,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetAncestor, GetClassNameW, GetCursorPos, GetForegroundWindow, GetMessageW, GetSystemMetrics,
        GetWindowLongPtrW, GetWindowThreadProcessId, KillTimer, PostThreadMessageW, SendMessageTimeoutW,
        SetForegroundWindow, SetLayeredWindowAttributes, SetTimer, SetWindowLongPtrW, SetWindowPos,
        SetWindowsHookExW, UnhookWindowsHookEx, WindowFromPoint, GA_ROOT, GWL_EXSTYLE, HWND_NOTOPMOST,
        HWND_TOPMOST, KBDLLHOOKSTRUCT, LLKHF_EXTENDED, LLKHF_UP, MSLLHOOKSTRUCT, WH_MOUSE_LL, LWA_ALPHA, MSG,
        SMTO_ABORTIFHUNG, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
        SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, WH_KEYBOARD_LL, WM_MOUSEHWHEEL, WM_MOUSEWHEEL, WM_QUIT,
        WM_TIMER, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOPMOST, WS_EX_TRANSPARENT,
    };

    fn hwnd(h: isize) -> HWND {
        HWND(h as *mut _)
    }

    fn exstyle(h: isize) -> u32 {
        // SAFETY: a read of a window long; a dead window answers 0.
        unsafe { GetWindowLongPtrW(hwnd(h), GWL_EXSTYLE) as u32 }
    }

    fn set_exstyle(h: isize, v: u32) {
        // SAFETY: GWL_EXSTYLE takes any style bits; this process owns the window.
        unsafe {
            SetWindowLongPtrW(hwnd(h), GWL_EXSTYLE, v as isize);
        }
    }

    fn zorder(h: isize, topmost: bool) {
        let after = if topmost { HWND_TOPMOST } else { HWND_NOTOPMOST };
        // SAFETY: a z-order change only.
        unsafe {
            let _ = SetWindowPos(hwnd(h), Some(after), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }
    }

    /// Volery into its driving clothes. Returns the style to put back.
    pub fn enter(h: isize) -> Result<u32, String> {
        let ex0 = exstyle(h);
        if ex0 == 0 {
            return Err("no main window to drive from".into());
        }
        set_exstyle(h, ex0 | WS_EX_TRANSPARENT.0 | WS_EX_NOACTIVATE.0);
        zorder(h, true);
        Ok(ex0)
    }

    pub fn restore(h: isize, ex0: u32) {
        set_exstyle(h, ex0);
        // a wall that was always-on-top before stays so
        zorder(h, ex0 & WS_EX_TOPMOST.0 != 0);
    }

    /// Give Volery the foreground. A process may only take it while it holds
    /// it or was handed it; attached to the input of the thread that has it,
    /// the call is allowed — the probe's `SetForegroundWindow` from the lab's
    /// foreground answered true the same way.
    pub fn activate(h: isize) {
        // SAFETY: attach and detach are paired; both threads are live.
        unsafe {
            let front = GetWindowThreadProcessId(GetForegroundWindow(), None);
            let me = GetCurrentThreadId();
            let attached = front != 0 && front != me && AttachThreadInput(me, front, true).as_bool();
            let _ = SetForegroundWindow(hwnd(h));
            if attached {
                let _ = AttachThreadInput(me, front, false);
            }
        }
    }

    fn mouse(flags: MOUSE_EVENT_FLAGS, dx: i32, dy: i32, data: u32) -> INPUT {
        INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 { mi: MOUSEINPUT { dx, dy, mouseData: data, dwFlags: flags, time: 0, dwExtraInfo: MARK } },
        }
    }

    fn virt() -> Rect {
        // SAFETY: metric reads.
        unsafe {
            Rect {
                x: GetSystemMetrics(SM_XVIRTUALSCREEN),
                y: GetSystemMetrics(SM_YVIRTUALSCREEN),
                w: GetSystemMetrics(SM_CXVIRTUALSCREEN),
                h: GetSystemMetrics(SM_CYVIRTUALSCREEN),
            }
        }
    }

    fn move_to(p: (i32, i32), v: Rect) -> INPUT {
        let (x, y) = to_virtual(p, v);
        mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, x, y, 0)
    }

    fn press(b: Button, up: bool) -> INPUT {
        let (f, data) = match (b, up) {
            (Button::Left, false) => (MOUSEEVENTF_LEFTDOWN, 0),
            (Button::Left, true) => (MOUSEEVENTF_LEFTUP, 0),
            (Button::Right, false) => (MOUSEEVENTF_RIGHTDOWN, 0),
            (Button::Right, true) => (MOUSEEVENTF_RIGHTUP, 0),
            (Button::Middle, false) => (MOUSEEVENTF_MIDDLEDOWN, 0),
            (Button::Middle, true) => (MOUSEEVENTF_MIDDLEUP, 0),
            (Button::Back, false) => (MOUSEEVENTF_XDOWN, 1),
            (Button::Back, true) => (MOUSEEVENTF_XUP, 1),
            (Button::Forward, false) => (MOUSEEVENTF_XDOWN, 2),
            (Button::Forward, true) => (MOUSEEVENTF_XUP, 2),
        };
        mouse(f, 0, 0, data)
    }

    fn send(v: &[INPUT]) {
        // SAFETY: initialised INPUTs and their size.
        unsafe { SendInput(v, std::mem::size_of::<INPUT>() as i32) };
    }

    fn cursor() -> (i32, i32) {
        let mut p = POINT::default();
        // SAFETY: an out-parameter.
        unsafe {
            let _ = GetCursorPos(&mut p);
        }
        (p.x, p.y)
    }

    /// Let clicks through for a moment: layered *and* transparent is what
    /// passes one (transparent alone, which the drive already wears, does not).
    fn open(h: isize, ex0: u32) {
        set_exstyle(h, ex0 | WS_EX_TRANSPARENT.0 | WS_EX_NOACTIVATE.0 | WS_EX_LAYERED.0);
        if ex0 & WS_EX_LAYERED.0 == 0 {
            // SAFETY: a fully opaque layered window draws as it did.
            unsafe {
                let _ = SetLayeredWindowAttributes(hwnd(h), COLORREF(0), 255, LWA_ALPHA);
            }
        }
    }

    fn close(h: isize, ex0: u32) {
        set_exstyle(h, ex0 | WS_EX_TRANSPARENT.0 | WS_EX_NOACTIVATE.0);
    }

    /// The window that would take a click at `p`, if it is not Volery's own —
    /// in which case the click-through did not take and nothing is sent, since
    /// a click there would land on the wall.
    fn under(p: (i32, i32)) -> Option<HWND> {
        // SAFETY: plain window queries.
        unsafe {
            let w = WindowFromPoint(POINT { x: p.0, y: p.1 });
            if w.is_invalid() {
                return None;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(GetAncestor(w, GA_ROOT), Some(&mut pid));
            (pid != GetCurrentProcessId()).then_some(w)
        }
    }

    /// Where a wheel goes. Windows' own "scroll inactive windows" sends it to
    /// the deepest window under the point, which is right for nearly
    /// everything — except Chromium's inner render window (and so every
    /// Electron app's), which hands the message to its frame *and* lets it
    /// travel on, so one notch scrolled the page twice: 200 px where the frame
    /// alone scrolled 100 (drive-probe, both measured). Its frame routes by the
    /// message's point, so the frame is the one to tell.
    fn wheel_target(w: HWND) -> HWND {
        let mut buf = [0u16; 64];
        // SAFETY: a class-name read into a local buffer.
        let n = unsafe { GetClassNameW(w, &mut buf) };
        if String::from_utf16_lossy(&buf[..n.max(0) as usize]) == "Chrome_RenderWidgetHostHWND" {
            // SAFETY: a plain ancestor query.
            unsafe { GetAncestor(w, GA_ROOT) }
        } else {
            w
        }
    }

    /// How many click-final moves the mouse hook has seen, and who waits.
    static SEEN: (Mutex<u64>, Condvar) = (Mutex::new(0), Condvar::new());

    /// The final move of a batch, marked so the hook can count it, and the
    /// count to wait past. Clicks are performed one at a time on the drive's
    /// own thread, so "the next one seen" is this one.
    fn move_back(p: (i32, i32), v: Rect) -> (INPUT, u64) {
        let seen = *SEEN.0.lock().unwrap();
        let (x, y) = to_virtual(p, v);
        let mut i = mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, x, y, 0);
        i.Anonymous.mi.dwExtraInfo = MARK_LAST;
        (i, seen)
    }

    /// The longest Volery stays click-through waiting for a click to land.
    /// Holding it longer is the dangerous direction: a real click on the tile
    /// in that window falls *through* Volery onto whatever is under it, where
    /// closing too early costs, at worst, one injected click landing on Volery.
    const SETTLE: Duration = Duration::from_millis(60);

    /// Wait until the raw input thread has taken the batch whose final move
    /// is counted past `seen`. It calls low-level hooks for each event in
    /// order, before it goes on to the next, so the hook seeing that move
    /// means the press and release before it have both been delivered — to
    /// the app, while Volery was still click-through.
    ///
    /// The first cut waited for the cursor to come back instead, and a cursor
    /// that is "back" reads the same as one that has not moved yet: polled
    /// before the batch had started, it closed Volery up again too early and
    /// the click landed on Volery. 7 of 10 clicks landed, in each of three
    /// arrangements (drive-probe, 2026-10-31).
    fn settle(seen: u64) {
        let (lock, cv) = &SEEN;
        let deadline = Instant::now() + SETTLE;
        let mut now = lock.lock().unwrap();
        while *now <= seen {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                super::GAVE_UP.fetch_add(1, Ordering::Relaxed);
                return;
            }
            now = cv.wait_timeout(now, left).unwrap().0;
        }
        super::CONFIRMED.fetch_add(1, Ordering::Relaxed);
    }

    unsafe extern "system" fn mouse_proc(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
        if code >= 0 {
            let m = &*(l.0 as *const MSLLHOOKSTRUCT);
            if m.dwExtraInfo == MARK_LAST {
                let (lock, cv) = &SEEN;
                if let Ok(mut seen) = lock.lock() {
                    *seen += 1;
                    cv.notify_all();
                }
            }
        }
        CallNextHookEx(None, code, w, l)
    }

    pub fn perform(h: isize, ex0: u32, g: &Gesture, left: &std::sync::atomic::AtomicBool) {
        let v = virt();
        let back = cursor();
        open(h, ex0);
        match g {
            Gesture::Click { button, at } => {
                if under(*at).is_some() {
                    let (last, seq) = move_back(back, v);
                    send(&[move_to(*at, v), press(*button, false), press(*button, true), last]);
                    settle(seq);
                }
            }
            Gesture::Drag { button, path } => {
                if under(path[0]).is_some() {
                    send(&[move_to(path[0], v), press(*button, false)]);
                    for p in &path[1..] {
                        std::thread::sleep(Duration::from_millis(8));
                        send(&[move_to(*p, v)]);
                    }
                    let (last, seq) = move_back(back, v);
                    send(&[press(*button, true), last]);
                    settle(seq);
                }
            }
            Gesture::Wheel { at, delta, horizontal } => {
                if let Some(w) = under(*at).map(wheel_target) {
                    let msg = if *horizontal { WM_MOUSEHWHEEL } else { WM_MOUSEWHEEL };
                    let wp = WPARAM(((*delta as i16 as u16 as usize) << 16) as usize);
                    let lp = LPARAM((((at.1 as i16 as u16 as u32) << 16) | at.0 as i16 as u16 as u32) as isize);
                    // SAFETY: a message with plain values; bounded wait.
                    unsafe {
                        let mut r = 0usize;
                        let _ = SendMessageTimeoutW(w, msg, wp, lp, SMTO_ABORTIFHUNG, 200, Some(&mut r));
                    }
                }
            }
        }
        /* A drive that ended while this click was in flight has already put
           Volery back; closing up now would dress it in the drive's styles
           again, after the restore. A guarded run caught exactly that. */
        if left.load(Ordering::SeqCst) {
            restore(h, ex0);
        } else {
            close(h, ex0);
        }
    }

    /// A whole Escape, for a tap the hook swallowed. Marked, so the hook lets
    /// it pass.
    pub fn replay_escape() {
        let key = |up: bool| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(0),
                    wScan: 0x01,
                    dwFlags: if up { KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP } else { KEYEVENTF_SCANCODE },
                    time: 0,
                    dwExtraInfo: MARK,
                },
            },
        };
        send(&[key(false), key(true)]);
    }

    /// A thread timer on the hook's thread, which is the one calling this.
    pub fn start_timer() -> usize {
        // SAFETY: a thread timer; WM_TIMER arrives in the hook's own loop.
        unsafe { SetTimer(None, 0, super::HOLD_MS, None) }
    }

    pub fn stop_timer(id: usize) {
        if id != 0 {
            // SAFETY: killing a timer that may already be gone is harmless.
            unsafe {
                let _ = KillTimer(None, id);
            }
        }
    }

    unsafe extern "system" fn proc(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
        if code >= 0 {
            let k = &*(l.0 as *const KBDLLHOOKSTRUCT);
            // our own replays pass; any other key, injected or not, is a person's
            if k.dwExtraInfo != MARK {
                let down = k.flags.0 & LLKHF_UP.0 == 0;
                let extended = k.flags.0 & LLKHF_EXTENDED.0 != 0;
                let front = GetForegroundWindow().0 as isize;
                let swallow = match super::HOOK.lock() {
                    Ok(mut g) => match g.as_mut() {
                        Some(s) => super::on_key(s, k.vkCode, k.scanCode, extended, down, front),
                        None => false,
                    },
                    Err(_) => false,
                };
                if swallow {
                    return LRESULT(1);
                }
            }
        }
        let _ = w;
        CallNextHookEx(None, code, w, l)
    }

    /// The hook's thread: install, answer whether it took, pump until told to
    /// stop. A low-level hook is called on the thread that installed it, in
    /// that thread's message loop — so this loop is the hook.
    /// `mouse` adds the low-level mouse hook a drive settles its clicks on.
    pub fn hook_loop(ready: Sender<Result<u32, String>>, mouse: bool) {
        // SAFETY: the hook procedures are plain functions; both hooks are
        // removed before the thread ends.
        unsafe {
            let module = GetModuleHandleW(None).ok();
            let hook = match SetWindowsHookExW(WH_KEYBOARD_LL, Some(proc), module.map(|m| m.into()), 0) {
                Ok(h) => h,
                Err(e) => {
                    let _ = ready.send(Err(e.to_string()));
                    return;
                }
            };
            let mouse_hook = if mouse {
                match SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), module.map(|m| m.into()), 0) {
                    Ok(h) => Some(h),
                    Err(e) => {
                        let _ = UnhookWindowsHookEx(hook);
                        let _ = ready.send(Err(e.to_string()));
                        return;
                    }
                }
            } else {
                None
            };
            let _ = ready.send(Ok(GetCurrentThreadId()));
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                if msg.message == WM_TIMER {
                    super::on_timer();
                }
            }
            let _ = UnhookWindowsHookEx(hook);
            if let Some(m) = mouse_hook {
                let _ = UnhookWindowsHookEx(m);
            }
        }
    }

    pub fn stop_loop(thread: u32) {
        // SAFETY: posting to a thread that may already have ended fails quietly.
        unsafe {
            let _ = PostThreadMessageW(thread, WM_QUIT, WPARAM(0), LPARAM(0));
        }
    }
}

#[cfg(not(windows))]
mod os {
    use super::{Gesture, Rect};
    use std::sync::mpsc::Sender;
    pub fn enter(_: isize) -> Result<u32, String> {
        Err("driving this machine through its tile is Windows-only".into())
    }
    pub fn restore(_: isize, _: u32) {}
    pub fn activate(_: isize) {}
    pub fn perform(_: isize, _: u32, _: &Gesture, _: &std::sync::atomic::AtomicBool) {}
    pub fn replay_escape() {}
    pub fn start_timer() -> usize {
        0
    }
    pub fn stop_timer(_: usize) {}
    pub fn hook_loop(ready: Sender<Result<u32, String>>, _mouse: bool) {
        let _ = ready.send(Err("no keyboard hook off Windows".into()));
    }
    pub fn stop_loop(_: u32) {}
    #[allow(dead_code)]
    fn _r(_: Rect) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    const MON: Rect = Rect { x: 0, y: 0, w: 2560, h: 1600 };

    fn gestures(events: &[Input]) -> Vec<Gesture> {
        let mut p = Presses::default();
        let mut out = Vec::new();
        for e in events {
            p.fold(e, MON, &mut out);
        }
        out
    }

    #[test]
    fn a_press_that_stays_put_is_a_click_where_it_went_down() {
        let g = gestures(&[
            Input::MouseAbs { x: 32768, y: 32768 },
            Input::Button { button: Button::Left, down: true },
            Input::MouseAbs { x: 32800, y: 32768 }, // a few pixels of jitter
            Input::Button { button: Button::Left, down: false },
        ]);
        assert_eq!(g, [Gesture::Click { button: Button::Left, at: (1280, 800) }]);
    }

    #[test]
    fn a_press_that_travels_is_a_drag_along_its_path() {
        let g = gestures(&[
            Input::MouseAbs { x: 0, y: 32768 },
            Input::Button { button: Button::Left, down: true },
            Input::MouseAbs { x: 16384, y: 32768 },
            Input::MouseAbs { x: 32768, y: 32768 },
            Input::Button { button: Button::Left, down: false },
        ]);
        assert_eq!(g, [Gesture::Drag { button: Button::Left, path: vec![(0, 800), (640, 800), (1280, 800)] }]);
    }

    #[test]
    fn a_long_drag_is_thinned_but_keeps_both_ends() {
        let mut events = vec![Input::MouseAbs { x: 0, y: 0 }, Input::Button { button: Button::Left, down: true }];
        for i in 1..=200u32 {
            events.push(Input::MouseAbs { x: (i * 300) as u16, y: 0 });
        }
        events.push(Input::Button { button: Button::Left, down: false });
        let Gesture::Drag { path, .. } = &gestures(&events)[0] else { panic!("not a drag") };
        assert!(path.len() <= MAX_PATH, "{} points", path.len());
        assert_eq!(path[0], (0, 0));
        assert_eq!(*path.last().unwrap(), to_pixel(60000, 0, MON));
    }

    #[test]
    fn a_press_with_no_position_or_no_release_is_nothing() {
        assert!(gestures(&[
            Input::Button { button: Button::Left, down: true },
            Input::Button { button: Button::Left, down: false },
        ])
        .is_empty());
        assert!(gestures(&[
            Input::MouseAbs { x: 100, y: 100 },
            Input::Button { button: Button::Right, down: true },
            Input::ReleaseAll,
            Input::Button { button: Button::Right, down: false },
        ])
        .is_empty());
    }

    #[test]
    fn another_button_mid_press_does_not_end_the_first() {
        let g = gestures(&[
            Input::MouseAbs { x: 100, y: 100 },
            Input::Button { button: Button::Left, down: true },
            Input::Button { button: Button::Right, down: true },
            Input::Button { button: Button::Right, down: false },
            Input::Button { button: Button::Left, down: false },
        ]);
        assert_eq!(g.len(), 1);
        assert!(matches!(g[0], Gesture::Click { button: Button::Left, .. }));
    }

    #[test]
    fn keys_are_never_gestures_and_a_wheel_lands_where_the_pointer_is() {
        let g = gestures(&[
            Input::Key { scan: 0x1c, down: true },
            Input::MouseAbs { x: 65535, y: 0 },
            Input::Wheel { dx: 0, dy: -120 },
        ]);
        assert_eq!(g, [Gesture::Wheel { at: (2559, 0), delta: -120, horizontal: false }]);
    }

    #[test]
    fn a_tap_replays_and_a_hold_lets_go_once() {
        let mut e = EscHold::default();
        assert_eq!(e.key(true), Esc::Start);
        assert_eq!(e.key(true), Esc::Absorb); // auto-repeat
        assert_eq!(e.key(false), Esc::Tap);
        assert!(!e.timer(), "a timer arriving after the release lets go of nothing");

        assert_eq!(e.key(true), Esc::Start);
        assert!(e.timer());
        assert!(!e.timer());
        assert_eq!(e.key(true), Esc::Absorb);
        assert_eq!(e.key(false), Esc::End);

        // and the next press starts afresh
        assert_eq!(e.key(true), Esc::Start);
    }

    #[test]
    fn an_escape_released_that_the_hook_never_saw_pressed_is_not_a_tap() {
        assert_eq!(EscHold::default().key(false), Esc::End);
    }

    #[test]
    fn the_hooks_keys_read_as_the_wires_scancodes() {
        assert_eq!(wire_scan(0x41, 0x1e, false), Some(0x1e));
        assert_eq!(wire_scan(0x26, 0x48, true), Some(0xe048)); // up arrow
        assert_eq!(wire_scan(0x5b, 0x5b, true), Some(0xe05b)); // left Win
        assert_eq!(wire_scan(0x0d, 0x1c, true), Some(0xe01c)); // numpad Enter
        assert_eq!(wire_scan(VK_PAUSE, 0x45, false), Some(0xe11d));
        assert_eq!(wire_scan(VK_NUMLOCK, 0x45, true), Some(0x45));
        assert_eq!(wire_scan(VK_SNAPSHOT, 0x37, true), Some(0xe037));
        // AltGr's fake left Ctrl, and a key with no scancode
        assert_eq!(wire_scan(0xa2, 0x21d, false), None);
        assert_eq!(wire_scan(0xff, 0, false), None);
    }

    fn state(capture: bool) -> (HookState, mpsc::Receiver<Ask>) {
        let (asks, rx) = mpsc::channel();
        (HookState { capture, volery: 7, esc: EscHold::default(), timer: 0, asks, down: BTreeSet::new() }, rx)
    }

    #[test]
    fn native_mode_watches_escape_and_lets_everything_else_through() {
        let (mut s, rx) = state(false);
        assert!(!on_key(&mut s, 0x41, 0x1e, false, true, 99));
        assert!(on_key(&mut s, VK_ESCAPE, 0x01, false, true, 99));
        assert!(on_key(&mut s, VK_ESCAPE, 0x01, false, false, 99));
        let asks: Vec<_> = rx.try_iter().collect();
        assert!(matches!(asks[..], [Ask::Phase("down"), Ask::Phase("up"), Ask::Tap]));
    }

    #[test]
    fn capture_takes_every_key_while_volery_is_in_front_and_none_when_it_is_not() {
        let (mut s, rx) = state(true);
        assert!(on_key(&mut s, 0x5b, 0x5b, true, true, 7)); // Win, Volery in front
        assert!(on_key(&mut s, 0x5b, 0x5b, true, false, 7));
        assert!(!on_key(&mut s, 0x41, 0x1e, false, true, 8)); // another app in front
        assert!(on_key(&mut s, 0xa2, 0x21d, false, true, 7)); // AltGr's fake Ctrl: swallowed, not sent
        let sent: Vec<Input> = rx
            .try_iter()
            .flat_map(|a| match a {
                Ask::Keys(k) => k,
                _ => vec![],
            })
            .collect();
        assert_eq!(sent, [Input::Key { scan: 0xe05b, down: true }, Input::Key { scan: 0xe05b, down: false }]);
        assert!(s.down.is_empty());
    }

    #[test]
    fn capture_lets_windows_have_the_up_of_a_key_pressed_before_it() {
        let (mut s, _rx) = state(true);
        assert!(!on_key(&mut s, 0x10, 0x2a, false, false, 7));
    }
}
