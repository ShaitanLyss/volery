//! The screen under a card's browser: held awake while a card is driving the
//! shared browser, and read for the two states in which no page can draw a
//! real frame — locked, and off.
//!
//! Asked for on 2026-10-27, after a card measuring frame rates in the shared
//! Chrome recorded 0.998 fps for an hour (the cause turned out to be a tab
//! behind another tab — `browserframes.cjs` — but the question Lyss asked
//! next is the one this file answers): *"could volery unsleep the screen when a
//! card wants to run some fps testing or frame analysis?"* Her answer to the
//! offer was to keep the screen awake while a card uses the browser.
//!
//! ### Awake while a card is at work in the browser
//!
//! `browserhost.cjs` posts to `ask::FRAMES_PATH` before and after every
//! browser tool call, and each post is `touch`. The first touch takes a
//! **display-required** power request; it is let go `HOLD` after the last one,
//! so a card that stopped driving the browser gives the screen back to its own
//! timeout two minutes later and the screen still sleeps overnight.
//!
//! This is the one place Volery asks for the display. `machine.rs` holds a
//! *system* request on mains and says in as many words that the screen may
//! sleep; that stays true of the wall at large. A request rather than
//! `SetThreadExecutionState` for `machine.rs`'s reason: the execution state is a
//! flag on a thread, and the release here is done by whichever thread notices
//! the hold has run out. Not gated on mains: two minutes past a card's last
//! browser call is a bounded cost on battery, and a measurement taken on
//! battery is still one somebody wanted.
//!
//! The release is one thread that exists only while the request is held and
//! sleeps to the deadline — it is not a poller, because nothing announces that
//! a card has *stopped* driving the browser; the absence of calls is the
//! event, and a deadline is the only way to hear an absence.
//!
//! ### Locked and off
//!
//! Neither is visible from inside a page: Playwright emulates focus, so a page
//! reports `visible` and focused whatever Windows is doing with the desktop.
//! So the post is answered with a sentence when either holds, and the host
//! appends it to the tool result.
//!
//! - **Off** is folded, not sampled: `GUID_CONSOLE_DISPLAY_STATE` calls back on
//!   every change and once at registration, the same arrangement
//!   `machine::subscribe_power` makes for the power source. With the request
//!   held it should not happen while a card works, which is the point; it is
//!   said because a display can be switched off by hand, or was already off
//!   when the first call came.
//! - **Locked** is asked when the post arrives, since a lock has no callback
//!   that does not need a window: the input desktop cannot be opened while the
//!   secure desktop has it (`OpenInputDesktop`), which is the long-standing way
//!   a process without a window tells. Volery must never unlock anything, and
//!   cannot; the card is told, and that is all.
//!
//! The sentence is careful about what is known. A minimised Chrome window and a
//! background tab were measured to draw no frames or one a second; a locked
//! session was not measured (it would mean locking the machine under a probe)
//! and the note says "may", which is what a card needs to treat the number as
//! suspect without being told something nobody checked.

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long the screen is held after a card's last browser call. Lyss's
/// number ("a couple of minutes"), and the length of `mcphost::TAB_GRACE`, so
/// the screen and a dormant card's tabs are let go on the same clock.
pub const HOLD: Duration = Duration::from_secs(120);

/// What `powercfg /requests` prints beside our name.
const REASON: &str = "Volery: a card is driving the browser (frame timings need the screen on)";

/// What the console display last said: `GUID_CONSOLE_DISPLAY_STATE`'s values,
/// with `UNKNOWN` before the first callback or where nothing can say.
const UNKNOWN: u8 = u8::MAX;
static DISPLAY: AtomicU8 = AtomicU8::new(UNKNOWN);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Display {
    Off,
    On,
    Dimmed,
    Unknown,
}

fn display_from(v: u8) -> Display {
    match v {
        0 => Display::Off,
        1 => Display::On,
        2 => Display::Dimmed,
        _ => Display::Unknown,
    }
}

pub fn display() -> Display {
    display_from(DISPLAY.load(Ordering::Relaxed))
}

/// Whether the request is held, and until when.
struct Held {
    request: isize,
    until: Option<Instant>,
}

static HELD: Mutex<Option<Held>> = Mutex::new(None);

/// Start hearing the display. Once, at `open_wall`; a failure is logged and
/// the display reads as unknown, which says nothing rather than something false.
pub fn install() {
    if let Err(e) = os::subscribe_display() {
        log::warn!("screen: could not subscribe to the display state: {e}");
    }
}

/// A card is at work in the browser: hold the screen on until `HOLD` from now.
pub fn touch() {
    let Ok(mut held) = HELD.lock() else { return };
    let until = Instant::now() + HOLD;
    match held.as_mut() {
        Some(h) if h.until.is_some() => {
            h.until = Some(until);
            return;
        }
        Some(h) => {
            if let Err(e) = os::hold(h.request, true) {
                log::warn!("screen: could not hold the display on: {e}");
                return;
            }
            h.until = Some(until);
        }
        None => {
            let request = match os::make_request(REASON) {
                Ok(r) => r,
                Err(e) => {
                    log::warn!("screen: no display request: {e}");
                    return;
                }
            };
            if let Err(e) = os::hold(request, true) {
                log::warn!("screen: could not hold the display on: {e}");
                *held = Some(Held { request, until: None });
                return;
            }
            *held = Some(Held { request, until: Some(until) });
        }
    }
    log::info!("screen: holding the display on while a card drives the browser");
    std::thread::Builder::new()
        .name("screen-hold".into())
        .spawn(watch_out)
        .ok();
}

/// Sleep to the deadline, re-read it, and let go once it has really passed.
/// Exits when it lets go; the next `touch` starts another.
fn watch_out() {
    loop {
        let wait = {
            let Ok(mut held) = HELD.lock() else { return };
            let Some(h) = held.as_mut() else { return };
            let Some(until) = h.until else { return };
            let now = Instant::now();
            if now >= until {
                let _ = os::hold(h.request, false);
                h.until = None;
                log::info!("screen: let the display go, no card has driven the browser for {}s", HOLD.as_secs());
                return;
            }
            until - now
        };
        std::thread::sleep(wait);
    }
}

/// Let go now. The exit handler's, so a quit does not leave the request to
/// the process's death — which would release it anyway, but say nothing.
pub fn release() {
    if let Ok(mut held) = HELD.lock() {
        if let Some(h) = held.as_mut() {
            if h.until.take().is_some() {
                let _ = os::hold(h.request, false);
            }
        }
    }
}

/// What a card is told about the screen after a browser call, or nothing.
pub fn note() -> Option<String> {
    frames_note(os::locked(), display())
}

/// The sentence, pure. Locked wins: a locked session's display state says
/// nothing about this desktop.
pub fn frames_note(locked: bool, display: Display) -> Option<String> {
    let lead = if locked {
        "The screen is locked. While it is, Windows may not compose this desktop at all"
    } else if display == Display::Off {
        "The screen is off. While it is, Windows may not compose this desktop at all"
    } else {
        return None;
    };
    Some(format!(
        "### Frames\n{lead}, and Chrome can stop drawing frames without the page being able to tell \
         — it still reports `visibilityState: \"visible\"` and focus, because Playwright emulates focus. \
         Treat any frame rate, requestAnimationFrame timing, long-frame count or screencast taken now as \
         suspect, and measure again once the user is back at the machine. Volery cannot unlock or wake \
         the machine for you; if the measurement matters, say so to the user."
    ))
}

#[cfg(windows)]
mod os {
    use windows::core::{GUID, PWSTR};
    use windows::Win32::Foundation::{ERROR_SUCCESS, HANDLE};
    use windows::Win32::System::Power::{
        PowerClearRequest, PowerCreateRequest, PowerRequestDisplayRequired, PowerSetRequest,
        PowerSettingRegisterNotification, DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS, POWERBROADCAST_SETTING,
    };
    use windows::Win32::System::StationsAndDesktops::{
        CloseDesktop, OpenInputDesktop, SwitchDesktop, DESKTOP_CONTROL_FLAGS, DESKTOP_SWITCHDESKTOP,
    };
    use windows::Win32::System::Threading::{POWER_REQUEST_CONTEXT_SIMPLE_STRING, REASON_CONTEXT};
    use windows::Win32::UI::WindowsAndMessaging::{DEVICE_NOTIFY_CALLBACK, PBT_POWERSETTINGCHANGE};

    /// winnt.h, spelled here for `machine.rs`'s reason.
    const CONSOLE_DISPLAY_STATE: GUID = GUID::from_u128(0x6fe69556_704a_47a0_8f24_c28d936fda47);

    pub fn make_request(reason: &str) -> Result<isize, String> {
        /* Leaked once: the reason outlives the call, and there is at most one
           request per process (`HELD` keeps it). */
        let wide: &'static mut [u16] =
            Box::leak(reason.encode_utf16().chain(Some(0)).collect::<Vec<_>>().into_boxed_slice());
        let mut context = REASON_CONTEXT {
            Version: 0,
            Flags: POWER_REQUEST_CONTEXT_SIMPLE_STRING,
            ..Default::default()
        };
        context.Reason.SimpleReasonString = PWSTR(wide.as_mut_ptr());
        // SAFETY: a context whose string lives for the process.
        let handle = unsafe { PowerCreateRequest(&context) }.map_err(|e| e.to_string())?;
        Ok(handle.0 as isize)
    }

    pub fn hold(request: isize, on: bool) -> Result<(), String> {
        let handle = HANDLE(request as *mut core::ffi::c_void);
        // SAFETY: a request handle this process made and never closes.
        unsafe {
            if on {
                PowerSetRequest(handle, PowerRequestDisplayRequired)
            } else {
                PowerClearRequest(handle, PowerRequestDisplayRequired)
            }
        }
        .map_err(|e| e.to_string())
    }

    unsafe extern "system" fn on_display(
        _context: *const core::ffi::c_void,
        kind: u32,
        setting: *const core::ffi::c_void,
    ) -> u32 {
        if kind == PBT_POWERSETTINGCHANGE && !setting.is_null() {
            // SAFETY: Windows hands a POWERBROADCAST_SETTING for this kind;
            // `Data` is `DataLength` bytes and may not be aligned.
            let s = unsafe { &*(setting as *const POWERBROADCAST_SETTING) };
            if s.PowerSetting == CONSOLE_DISPLAY_STATE && s.DataLength >= 4 {
                let v = unsafe { std::ptr::read_unaligned(s.Data.as_ptr() as *const u32) };
                super::DISPLAY.store(v.min(u8::MAX as u32 - 1) as u8, std::sync::atomic::Ordering::Relaxed);
            }
        }
        0
    }

    pub fn subscribe_display() -> Result<(), String> {
        let params: &'static DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS =
            Box::leak(Box::new(DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS {
                Callback: Some(on_display),
                Context: std::ptr::null_mut(),
            }));
        let mut registration: *mut core::ffi::c_void = std::ptr::null_mut();
        // SAFETY: the GUID and the parameters outlive the registration.
        let result = unsafe {
            PowerSettingRegisterNotification(
                &CONSOLE_DISPLAY_STATE,
                DEVICE_NOTIFY_CALLBACK,
                HANDLE(params as *const _ as *mut core::ffi::c_void),
                &mut registration,
            )
        };
        if result == ERROR_SUCCESS {
            Ok(())
        } else {
            Err(format!("PowerSettingRegisterNotification answered {}", result.0))
        }
    }

    /// The input desktop cannot be opened for switching while the secure
    /// desktop holds it, and where it can be opened, switching to it fails —
    /// both are "locked" (or a UAC prompt, during which this desktop is not
    /// composed either). Switching to the desktop that already has the input
    /// changes nothing.
    pub fn locked() -> bool {
        // SAFETY: a handle we close at once.
        match unsafe { OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_SWITCHDESKTOP) } {
            Ok(desk) => {
                let switched = unsafe { SwitchDesktop(desk) }.is_ok();
                let _ = unsafe { CloseDesktop(desk) };
                !switched
            }
            Err(_) => true,
        }
    }
}

#[cfg(not(windows))]
mod os {
    pub fn make_request(_: &str) -> Result<isize, String> {
        Err("holding the display is Windows-only".into())
    }
    pub fn hold(_: isize, _: bool) -> Result<(), String> {
        Err("holding the display is Windows-only".into())
    }
    pub fn subscribe_display() -> Result<(), String> {
        Err("the display state is Windows-only".into())
    }
    pub fn locked() -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_is_said_while_the_screen_is_on_and_unlocked() {
        assert_eq!(frames_note(false, Display::On), None);
        assert_eq!(frames_note(false, Display::Dimmed), None);
        /* Unknown says nothing rather than something false: a machine whose
           display could not be heard is not a machine whose screen is off. */
        assert_eq!(frames_note(false, Display::Unknown), None);
    }

    #[test]
    fn locked_and_off_each_say_so_and_what_to_do() {
        let locked = frames_note(true, Display::On).unwrap();
        assert!(locked.starts_with("### Frames\nThe screen is locked."));
        assert!(locked.contains("visible"));
        assert!(locked.contains("measure again"));
        let off = frames_note(false, Display::Off).unwrap();
        assert!(off.starts_with("### Frames\nThe screen is off."));
        /* Locked wins: the display state of a locked session is not this
           desktop's. */
        assert_eq!(frames_note(true, Display::Off), Some(locked));
    }

    #[test]
    fn the_display_values_are_windows_own() {
        assert_eq!(display_from(0), Display::Off);
        assert_eq!(display_from(1), Display::On);
        assert_eq!(display_from(2), Display::Dimmed);
        assert_eq!(display_from(UNKNOWN), Display::Unknown);
    }
}
