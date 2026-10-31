//! Putting a far viewer's input into this machine: the host half of driving a
//! screen. `hub` hands each viewer session a [`Driver`]; its events are
//! applied here, on one thread of their own, through `SendInput`.
//!
//! **A stuck key on the far machine is the worst failure in this subsystem** —
//! nobody may be sitting at it, and a held Ctrl turns every later click into
//! something else. So every key and button a viewer presses is remembered per
//! viewer, and lifted on `ReleaseAll` (the tile lost focus) and when the
//! viewer goes (`Driver` dropped: the socket closed, the flyway link died).
//! It lifts exactly what *that* viewer holds: a key the person at this machine
//! is holding, or another viewer, is not this viewer's to let go of. For the
//! same reason an up for a key this viewer does not hold is dropped rather
//! than sent.
//!
//! **Scancodes, not virtual keys** (`KEYEVENTF_SCANCODE`, with
//! `KEYEVENTF_EXTENDEDKEY` for `0xE0xx`): the viewer names the physical key
//! and *this* machine's layout decides what it types. Lyss's machines are
//! French AZERTY, so a viewer on a US board pressing the key labelled Q types
//! A here — which is what Parsec does, and right, since this machine's
//! shortcuts are laid out for its own layout. Three keys go as virtual keys
//! instead, because their set-1 codes do not survive a scancode-flagged
//! `SendInput` the same way across keyboard drivers: Pause (the viewer's
//! sentinel `0xE11D`, since its real make is `E1 1D 45`), NumLock (`0x45`,
//! which Windows itself reports inverted from set 1) and PrintScreen.
//!
//! **What cannot be reached is said, not swallowed.** `SendInput` into a
//! window of an elevated process from a Volery that is not elevated is
//! dropped by UIPI with no error at all, so the foreground window's elevation
//! is asked whenever input is applied; and while the secure desktop holds the
//! input (a UAC prompt, the lock screen) nothing is inserted. Both land in
//! [`Driver::reach`] for the tile to show.
//!
//! The pure parts — where a normalised point lands, and what a viewer holds —
//! are tested below; the Win32 half is a thin translation of their output.

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, OnceLock};

use super::{Button, Input, Monitor};

/* ── where a point lands ───────────────────────────────────────────────── */

/// A rectangle of the desktop in physical pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl From<&Monitor> for Rect {
    fn from(m: &Monitor) -> Rect {
        Rect { x: m.x, y: m.y, w: m.w as i32, h: m.h as i32 }
    }
}

/// A viewer's 0..=65535 over one monitor → the desktop pixel it means. The
/// ends land on the first and last pixel, so a pointer at the edge of the tile
/// reaches the taskbar rather than stopping one short of it.
pub fn to_pixel(nx: u16, ny: u16, mon: Rect) -> (i32, i32) {
    let along = |n: u16, len: i32| ((n as i64 * (len.max(1) - 1) as i64 + 32767) / 65535) as i32;
    (mon.x + along(nx, mon.w), mon.y + along(ny, mon.h))
}

/// A desktop pixel → `SendInput`'s 0..=65535 over the *virtual* desktop
/// (`MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK`). Windows maps back with
/// a floor, so this rounds up: the obvious `px * 65535 / w` lands one pixel
/// short on most of the screen. Measured by `examples/drive-probe.rs`: a click
/// aimed this way read back at exactly the pixel asked for.
pub fn to_virtual(px: (i32, i32), virt: Rect) -> (i32, i32) {
    let along = |p: i32, o: i32, len: i32| {
        let len = len.max(1) as i64;
        (((p - o) as i64 * 65536 + len - 1) / len).clamp(0, 65535) as i32
    };
    (along(px.0, virt.x, virt.w), along(px.1, virt.y, virt.h))
}

/* ── what a viewer holds ───────────────────────────────────────────────── */

/// One thing for the OS to do, already decided: the Win32 half only spells it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Act {
    /// A scancode, `0xE0xx` for an extended key.
    Key { scan: u16, up: bool },
    /// The three keys that go as virtual keys (see the module comment).
    Vk { vk: u16, up: bool },
    /// Absolute, over the virtual desktop, 0..=65535.
    MoveTo { x: i32, y: i32 },
    Move { dx: i32, dy: i32 },
    Button { button: Button, up: bool },
    Wheel { delta: i32, horizontal: bool },
}

const VK_PAUSE: u16 = 0x13;
const VK_SNAPSHOT: u16 = 0x2c;
const VK_NUMLOCK: u16 = 0x90;

/// The viewer's Pause sentinel; see `src/lib/castinput.ts`.
pub const PAUSE: u16 = 0xe11d;

/// What every `SendInput` of this subsystem carries in `dwExtraInfo`, so the
/// keyboard hook in `drive` can tell input Volery put in itself (pass it on)
/// from a person's — and an injected key from anything else (an on-screen
/// keyboard, a remote tool, a probe standing in for a hand) counts as a
/// person's, which is what it stands for. "VOLY".
pub const MARK: usize = 0x564f_4c59;

/// The final move of one of `drive`'s clicks, which its mouse hook counts to
/// know the click has been delivered. A value of its own rather than a
/// sequence number packed above `MARK`: the first cut put one in the high 32
/// bits of `dwExtraInfo`, the hook never saw it, and every click held Volery
/// click-through for the whole timeout — long enough for the next real click
/// on the tile to fall through Volery onto whatever was under it.
pub const MARK_LAST: usize = 0x564f_4c5a;

fn key_act(scan: u16, up: bool) -> Option<Act> {
    Some(match scan {
        PAUSE => Act::Vk { vk: VK_PAUSE, up },
        0x45 => Act::Vk { vk: VK_NUMLOCK, up },
        0xe037 => Act::Vk { vk: VK_SNAPSHOT, up },
        s if s & 0xff00 == 0 || s & 0xff00 == 0xe000 => Act::Key { scan: s, up },
        // another prefix is nothing a keyboard sends; a guess is a key nobody pressed
        _ => return None,
    })
}

/// Every key and button one viewer has down on this machine.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Held {
    keys: BTreeSet<u16>,
    buttons: BTreeSet<u8>,
}

fn button_bit(b: Button) -> u8 {
    match b {
        Button::Left => 0,
        Button::Right => 1,
        Button::Middle => 2,
        Button::Back => 3,
        Button::Forward => 4,
    }
}

fn button_of(bit: u8) -> Button {
    match bit {
        0 => Button::Left,
        1 => Button::Right,
        2 => Button::Middle,
        3 => Button::Back,
        _ => Button::Forward,
    }
}

impl Held {
    pub fn is_empty(&self) -> bool {
        self.keys.is_empty() && self.buttons.is_empty()
    }

    /// Fold one event into what is held, and say what the OS should do.
    ///
    /// A down for a key already held is sent again — it is the viewer's
    /// auto-repeat, and Windows' own typematic sends exactly that. An up for
    /// one not held is dropped: it was already lifted by a `ReleaseAll`, or it
    /// is a key somebody else is holding.
    pub fn fold(&mut self, e: &Input, mon: Rect, virt: Rect, out: &mut Vec<Act>) {
        match *e {
            Input::MouseAbs { x, y } => {
                let (vx, vy) = to_virtual(to_pixel(x, y, mon), virt);
                out.push(Act::MoveTo { x: vx, y: vy });
            }
            Input::MouseRel { dx, dy } => out.push(Act::Move { dx: dx as i32, dy: dy as i32 }),
            Input::Button { button, down } => {
                let bit = button_bit(button);
                if down {
                    self.buttons.insert(bit);
                    out.push(Act::Button { button, up: false });
                } else if self.buttons.remove(&bit) {
                    out.push(Act::Button { button, up: true });
                }
            }
            Input::Wheel { dx, dy } => {
                if dy != 0 {
                    out.push(Act::Wheel { delta: dy as i32, horizontal: false });
                }
                if dx != 0 {
                    out.push(Act::Wheel { delta: dx as i32, horizontal: true });
                }
            }
            Input::Key { scan, down } => {
                let Some(act) = key_act(scan, !down) else { return };
                if down {
                    self.keys.insert(scan);
                    out.push(act);
                } else if self.keys.remove(&scan) {
                    out.push(act);
                }
            }
            Input::ReleaseAll => self.release(out),
        }
    }

    /// Lift everything, keys first and then buttons — a drag ending under a
    /// still-held Shift would be a shift-drag.
    pub fn release(&mut self, out: &mut Vec<Act>) {
        for scan in std::mem::take(&mut self.keys).into_iter().rev() {
            if let Some(a) = key_act(scan, true) {
                out.push(a);
            }
        }
        for bit in std::mem::take(&mut self.buttons) {
            out.push(Act::Button { button: button_of(bit), up: true });
        }
    }
}

/* ── the thread ────────────────────────────────────────────────────────── */

/// Whether this viewer's input is reaching anything.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Reach {
    /// Nothing applied yet, or the last batch went in.
    Ok = 0,
    /// The window in front belongs to an elevated process and Volery is not
    /// elevated: Windows drops the input without a word (UIPI).
    Elevated = 1,
    /// Nothing was inserted: the secure desktop has the input (a UAC prompt,
    /// the lock screen), or another thread blocked it.
    Blocked = 2,
}

impl Reach {
    fn from_u8(v: u8) -> Reach {
        match v {
            1 => Reach::Elevated,
            2 => Reach::Blocked,
            _ => Reach::Ok,
        }
    }

    /// The tile's words for it, lowercase and quiet like the rest of the wall.
    pub fn why(self) -> Option<&'static str> {
        match self {
            Reach::Ok => None,
            Reach::Elevated => Some("an administrator window is in front — input cannot reach it"),
            Reach::Blocked => Some("the machine is locked or asking for permission — input cannot reach it"),
        }
    }
}

enum Cmd {
    Apply { id: u64, mon: Rect, events: Vec<Input>, reach: Arc<AtomicU8> },
    Gone { id: u64 },
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);
static THREAD: OnceLock<Sender<Cmd>> = OnceLock::new();

/// The injector thread, started by the first viewer that drives. One for the
/// machine rather than one per viewer: Windows has one input stream, and
/// interleaving two viewers' batches is the most it could ever mean.
fn thread() -> &'static Sender<Cmd> {
    THREAD.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<Cmd>();
        std::thread::Builder::new()
            .name("cast-inject".into())
            .spawn(move || {
                let mut held: std::collections::HashMap<u64, Held> = Default::default();
                let mut acts = Vec::new();
                for cmd in rx {
                    acts.clear();
                    match cmd {
                        Cmd::Apply { id, mon, events, reach } => {
                            let virt = os::virtual_desktop();
                            let h = held.entry(id).or_default();
                            for e in &events {
                                h.fold(e, mon, virt, &mut acts);
                            }
                            if h.is_empty() {
                                held.remove(&id);
                            }
                            reach.store(os::send(&acts) as u8, Ordering::Relaxed);
                        }
                        Cmd::Gone { id } => {
                            if let Some(mut h) = held.remove(&id) {
                                h.release(&mut acts);
                                os::send(&acts);
                            }
                        }
                    }
                }
            })
            .expect("spawn the cast-inject thread");
        tx
    })
}

/// One viewer's hands on one monitor of this machine. Applying never blocks
/// the caller — events go to the injector thread — so the socket or flyway
/// thread that read them goes straight back to reading. Dropping it lifts
/// whatever this viewer still holds.
pub struct Driver {
    id: u64,
    mon: Rect,
    reach: Arc<AtomicU8>,
}

impl Driver {
    pub fn new(monitor: &Monitor) -> Driver {
        Driver {
            id: NEXT_ID.fetch_add(1, Ordering::Relaxed),
            mon: Rect::from(monitor),
            reach: Arc::new(AtomicU8::new(Reach::Ok as u8)),
        }
    }

    /// The monitor moved or changed size (a resolution change, a dock): the
    /// same normalised point now means a different pixel.
    pub fn retarget(&mut self, monitor: &Monitor) {
        self.mon = Rect::from(monitor);
    }

    pub fn apply(&self, events: &[Input]) {
        if events.is_empty() {
            return;
        }
        let _ = thread().send(Cmd::Apply {
            id: self.id,
            mon: self.mon,
            events: events.to_vec(),
            reach: self.reach.clone(),
        });
    }

    /// What the last batch met. Read it when sending the tile a state.
    pub fn reach(&self) -> Reach {
        Reach::from_u8(self.reach.load(Ordering::Relaxed))
    }
}

impl Drop for Driver {
    fn drop(&mut self) {
        if let Some(tx) = THREAD.get() {
            let _ = tx.send(Cmd::Gone { id: self.id });
        }
    }
}

/* ── Win32 ─────────────────────────────────────────────────────────────── */

#[cfg(windows)]
mod os {
    use super::{Act, Button, Reach, Rect};
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
    use windows::Win32::System::Threading::{
        GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYBD_EVENT_FLAGS,
        KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE, MOUSEEVENTF_ABSOLUTE,
        MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN,
        MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP,
        MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL, MOUSEEVENTF_XDOWN, MOUSEEVENTF_XUP, MOUSEINPUT,
        MOUSE_EVENT_FLAGS, VIRTUAL_KEY,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetSystemMetrics, GetWindowThreadProcessId, SM_CXVIRTUALSCREEN,
        SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
    };

    const XBUTTON1: u32 = 0x0001;
    const XBUTTON2: u32 = 0x0002;

    pub fn virtual_desktop() -> Rect {
        // SAFETY: plain metric reads.
        unsafe {
            Rect {
                x: GetSystemMetrics(SM_XVIRTUALSCREEN),
                y: GetSystemMetrics(SM_YVIRTUALSCREEN),
                w: GetSystemMetrics(SM_CXVIRTUALSCREEN),
                h: GetSystemMetrics(SM_CYVIRTUALSCREEN),
            }
        }
    }

    fn mouse(flags: MOUSE_EVENT_FLAGS, dx: i32, dy: i32, data: u32) -> INPUT {
        INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT { dx, dy, mouseData: data, dwFlags: flags, time: 0, dwExtraInfo: super::MARK },
            },
        }
    }

    fn key(vk: u16, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT { wVk: VIRTUAL_KEY(vk), wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: super::MARK },
            },
        }
    }

    fn input_of(a: &Act) -> INPUT {
        match *a {
            Act::Key { scan, up } => {
                let mut f = KEYEVENTF_SCANCODE;
                if scan & 0xff00 == 0xe000 {
                    f |= KEYEVENTF_EXTENDEDKEY;
                }
                if up {
                    f |= KEYEVENTF_KEYUP;
                }
                key(0, scan & 0xff, f)
            }
            Act::Vk { vk, up } => key(vk, 0, if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) }),
            Act::MoveTo { x, y } => {
                mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, x, y, 0)
            }
            Act::Move { dx, dy } => mouse(MOUSEEVENTF_MOVE, dx, dy, 0),
            Act::Button { button, up } => {
                let (flags, data) = match (button, up) {
                    (Button::Left, false) => (MOUSEEVENTF_LEFTDOWN, 0),
                    (Button::Left, true) => (MOUSEEVENTF_LEFTUP, 0),
                    (Button::Right, false) => (MOUSEEVENTF_RIGHTDOWN, 0),
                    (Button::Right, true) => (MOUSEEVENTF_RIGHTUP, 0),
                    (Button::Middle, false) => (MOUSEEVENTF_MIDDLEDOWN, 0),
                    (Button::Middle, true) => (MOUSEEVENTF_MIDDLEUP, 0),
                    (Button::Back, false) => (MOUSEEVENTF_XDOWN, XBUTTON1),
                    (Button::Back, true) => (MOUSEEVENTF_XUP, XBUTTON1),
                    (Button::Forward, false) => (MOUSEEVENTF_XDOWN, XBUTTON2),
                    (Button::Forward, true) => (MOUSEEVENTF_XUP, XBUTTON2),
                };
                mouse(flags, 0, 0, data)
            }
            /* A signed delta in a DWORD that Win32 reads back as a short; see
               `control.rs`'s wheel for the same two's complement. */
            Act::Wheel { delta, horizontal } => mouse(
                if horizontal { MOUSEEVENTF_HWHEEL } else { MOUSEEVENTF_WHEEL },
                0,
                0,
                delta as u32,
            ),
        }
    }

    fn elevated(process: HANDLE) -> Option<bool> {
        // SAFETY: the token handle is closed before returning; the buffer is
        // a TOKEN_ELEVATION of the size passed.
        unsafe {
            let mut token = HANDLE::default();
            OpenProcessToken(process, TOKEN_QUERY, &mut token).ok()?;
            let mut e = TOKEN_ELEVATION::default();
            let mut len = 0u32;
            let ok = GetTokenInformation(
                token,
                TokenElevation,
                Some(&mut e as *mut _ as *mut _),
                std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                &mut len,
            );
            let _ = CloseHandle(token);
            ok.ok()?;
            Some(e.TokenIsElevated != 0)
        }
    }

    /// Whether the window in front is out of this process's reach by UIPI.
    /// A process whose token cannot even be opened from here is the same
    /// answer in practice: it is more privileged than we are.
    fn front_out_of_reach() -> bool {
        // SAFETY: handles are checked and closed.
        unsafe {
            if elevated(GetCurrentProcess()) == Some(true) {
                return false;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(GetForegroundWindow(), Some(&mut pid));
            if pid == 0 {
                return false;
            }
            let Ok(p) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                return false;
            };
            let answer = elevated(p).unwrap_or(true);
            let _ = CloseHandle(p);
            answer
        }
    }

    /// One `SendInput` for the batch, so nothing from another source lands in
    /// the middle of it. Returns what the batch met.
    pub fn send(acts: &[Act]) -> Reach {
        if acts.is_empty() {
            return Reach::Ok;
        }
        let inputs: Vec<INPUT> = acts.iter().map(input_of).collect();
        // SAFETY: a slice of fully initialised INPUTs and their size.
        let n = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
        if (n as usize) < inputs.len() {
            Reach::Blocked
        } else if front_out_of_reach() {
            Reach::Elevated
        } else {
            Reach::Ok
        }
    }
}

#[cfg(not(windows))]
mod os {
    use super::{Act, Reach, Rect};
    pub fn virtual_desktop() -> Rect {
        Rect { x: 0, y: 0, w: 1, h: 1 }
    }
    pub fn send(acts: &[Act]) -> Reach {
        if acts.is_empty() {
            Reach::Ok
        } else {
            Reach::Blocked
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LAPTOP: Rect = Rect { x: 0, y: 0, w: 2560, h: 1600 };
    /// A second screen to the left of the first, so the virtual desktop
    /// starts at a negative x.
    const LEFT: Rect = Rect { x: -1920, y: 200, w: 1920, h: 1080 };
    const BOTH: Rect = Rect { x: -1920, y: 0, w: 4480, h: 1600 };

    #[test]
    fn the_ends_of_the_tile_are_the_ends_of_the_monitor() {
        assert_eq!(to_pixel(0, 0, LAPTOP), (0, 0));
        assert_eq!(to_pixel(65535, 65535, LAPTOP), (2559, 1599));
        assert_eq!(to_pixel(32768, 32768, LAPTOP), (1280, 800));
        assert_eq!(to_pixel(0, 0, LEFT), (-1920, 200));
        assert_eq!(to_pixel(65535, 65535, LEFT), (-1, 1279));
    }

    #[test]
    fn a_pixel_maps_to_the_virtual_value_windows_floors_back_to_it() {
        // Windows: pixel = floor(v * width / 65536) + origin
        let back = |v: i32, o: i32, len: i32| (v as i64 * len as i64 / 65536) as i32 + o;
        for px in [-1920, -1, 0, 1, 1279, 1280, 2559] {
            let (vx, _) = to_virtual((px, 0), BOTH);
            assert_eq!(back(vx, BOTH.x, BOTH.w), px, "pixel {px}");
        }
        for py in [0, 1, 799, 1599] {
            let (_, vy) = to_virtual((0, py), BOTH);
            assert_eq!(back(vy, BOTH.y, BOTH.h), py, "pixel {py}");
        }
        assert_eq!(to_virtual((-5000, 9000), BOTH), (0, 65535));
    }

    fn fold_all(h: &mut Held, events: &[Input]) -> Vec<Act> {
        let mut out = Vec::new();
        for e in events {
            h.fold(e, LAPTOP, LAPTOP, &mut out);
        }
        out
    }

    #[test]
    fn release_all_lifts_exactly_what_this_viewer_holds() {
        let mut h = Held::default();
        let acts = fold_all(
            &mut h,
            &[
                Input::Key { scan: 0x1d, down: true },   // ctrl
                Input::Key { scan: 0xe048, down: true }, // up arrow
                Input::Button { button: Button::Left, down: true },
                Input::Key { scan: 0x1e, down: true },
                Input::Key { scan: 0x1e, down: false },
                Input::ReleaseAll,
            ],
        );
        assert_eq!(
            &acts[5..],
            &[
                Act::Key { scan: 0xe048, up: true },
                Act::Key { scan: 0x1d, up: true },
                Act::Button { button: Button::Left, up: true },
            ]
        );
        assert!(h.is_empty());
        // and a second release has nothing left to lift
        assert!(fold_all(&mut h, &[Input::ReleaseAll]).is_empty());
    }

    #[test]
    fn an_up_for_something_not_held_is_not_sent() {
        let mut h = Held::default();
        assert!(fold_all(&mut h, &[Input::Key { scan: 0x2a, down: false }]).is_empty());
        assert!(fold_all(&mut h, &[Input::Button { button: Button::Right, down: false }]).is_empty());
    }

    #[test]
    fn a_repeat_is_sent_again_and_lifted_once() {
        let mut h = Held::default();
        let acts = fold_all(
            &mut h,
            &[
                Input::Key { scan: 0x1e, down: true },
                Input::Key { scan: 0x1e, down: true },
                Input::Key { scan: 0x1e, down: false },
                Input::Key { scan: 0x1e, down: false },
            ],
        );
        assert_eq!(
            acts,
            [
                Act::Key { scan: 0x1e, up: false },
                Act::Key { scan: 0x1e, up: false },
                Act::Key { scan: 0x1e, up: true },
            ]
        );
    }

    #[test]
    fn the_three_awkward_keys_go_as_virtual_keys() {
        let mut h = Held::default();
        let acts = fold_all(
            &mut h,
            &[
                Input::Key { scan: PAUSE, down: true },
                Input::Key { scan: 0x45, down: true },
                Input::Key { scan: 0xe037, down: true },
                Input::Key { scan: 0xe11e, down: true },
            ],
        );
        assert_eq!(
            acts,
            [
                Act::Vk { vk: VK_PAUSE, up: false },
                Act::Vk { vk: VK_NUMLOCK, up: false },
                Act::Vk { vk: VK_SNAPSHOT, up: false },
            ]
        );
        // an unknown prefix is never held, so it is never "released" either
        let mut out = Vec::new();
        h.release(&mut out);
        assert_eq!(out.len(), 3);
    }

    #[test]
    fn a_wheel_splits_into_its_two_axes_and_a_move_lands_on_the_monitor() {
        let mut h = Held::default();
        let acts = fold_all(
            &mut h,
            &[Input::Wheel { dx: 40, dy: -120 }, Input::MouseAbs { x: 65535, y: 0 }],
        );
        assert_eq!(acts[0], Act::Wheel { delta: -120, horizontal: false });
        assert_eq!(acts[1], Act::Wheel { delta: 40, horizontal: true });
        assert_eq!(acts[2], Act::MoveTo { x: to_virtual((2559, 0), LAPTOP).0, y: 0 });
    }

    #[test]
    fn a_dropped_viewer_lifts_buttons_after_keys() {
        let mut h = Held::default();
        fold_all(
            &mut h,
            &[
                Input::Button { button: Button::Back, down: true },
                Input::Key { scan: 0x2a, down: true },
            ],
        );
        let mut out = Vec::new();
        h.release(&mut out);
        assert_eq!(
            out,
            [Act::Key { scan: 0x2a, up: true }, Act::Button { button: Button::Back, up: true }]
        );
    }
}
