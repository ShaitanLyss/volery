//! What Volery asks of the machine it runs on: to stay awake while it is on
//! mains power, and to be opened again when Windows went down under it.
//!
//! Both exist for the flyway. A wall that is not running is not a peer — the
//! roster shows nothing, a remote spawn is refused, the sink stops converging —
//! and on 2026-10-09 Lyss lost `AU-LT-288` to exactly that, from the other
//! machine, with no way to tell whether it had slept or restarted.
//!
//! **Nothing here needs a privilege**, and that is a constraint rather than a
//! taste: that laptop is a company machine with no admin rights on it. So no
//! service, no scheduled task that runs without a session, no auto-logon. What
//! survives is a power request, a per-user `Run` entry, and *reporting* the one
//! Windows setting that decides whether the `Run` entry is ever reached
//! unattended. See `.claude/rules/machine.md` for the ceiling that leaves.
//!
//! ### Awake
//!
//! A **power request** (`PowerCreateRequest` / `PowerSetRequest`) rather than
//! `SetThreadExecutionState`. They ask the kernel for the same thing, but the
//! request is a handle the process owns, where the execution state is a flag on
//! one *thread* and silently stops applying when that thread goes away — and no
//! thread in a Tauri app is obviously the one that lives for the process. The
//! request also carries a reason, which is what `powercfg /requests` prints
//! beside our name: a machine that will not sleep should say why where somebody
//! goes looking.
//!
//! `PowerRequestSystemRequired` and never the display one. The screen may sleep;
//! the machine may not.
//!
//! **On mains only**, and power changes, so it is folded rather than sampled:
//! `GUID_ACDC_POWER_SOURCE` delivers a callback on every change, and one at
//! registration with the current value. No window and no poll — the same event
//! `WM_POWERBROADCAST` carries, subscribed to by callback because the request
//! has no thread to deliver a window message to. On battery the request is
//! released, or Volery is the reason a laptop died in a bag.
//!
//! **A closed lid beats it.** Every power request is dropped on a sleep the
//! user starts — lid, power button, Start → Sleep — on Modern Standby and S3
//! alike, so on a laptop the commonest way to fall asleep is the one this cannot
//! stop. What closing the lid does on mains is a standard-user setting, so the
//! status reports it (`lid`) and the toggle says it in its own words.
//!
//! ### Reopen after a restart
//!
//! **The `Run` entry is the flag.** It is written when a wall opens and removed
//! when somebody closes the studio window, so a crash, a forced restart and
//! Windows going down under it all leave it in place — and all three mean *it
//! was open*. One fact in one place, and the behaviour falls out of the
//! ordering. `leave` is the removal, and *where* it is called is the whole of
//! whether this works: see the comment at its call site in `lib.rs`.
//!
//! `Run` fires at sign-in and not before, which is the honest limit:
//! `arso` reads whether Windows will sign her back in by itself after a
//! restart, and the front end words what that means.

use serde::Serialize;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

/// The argument the `Run` entry launches with, so an autostart that finds a
/// wall already up can leave without a box. `hooks::intercept` lets exactly
/// this argv through — the studio otherwise refuses any argument at all.
pub const FLAG_AUTOSTART: &str = "--autostart";

/// Whether this process was launched by the `Run` entry.
pub fn autostarted() -> bool {
    std::env::args().skip(1).any(|a| a == FLAG_AUTOSTART)
}

/// Where the two knobs live: `HKCU\Software\Volery\<identifier>`.
///
/// The registry rather than the store, because both are facts about *this
/// Windows session* — a `Run` entry and a power request — and neither means
/// anything carried to another machine. It also keeps a schema rung out of a
/// week when three cards are already queued for them.
fn settings_key(identifier: &str) -> String {
    format!("Software\\Volery\\{identifier}")
}

const RUN_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
/// Where Task Manager's Startup tab records a switched-off entry. Windows
/// honours it without our help; we read it only to say so.
const APPROVED_KEY: &str =
    "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";

const KNOB_AWAKE: &str = "KeepAwakeOnMains";
const KNOB_REOPEN: &str = "ReopenAfterRestart";

/// What `powercfg /requests` prints beside the process. Written for the
/// person who went looking because the machine would not sleep.
const REASON: &str = "Volery is keeping this machine awake while it is on mains power, so the \
                      wall stays reachable from your other machines. Turn it off from the \
                      wall's right-click menu, or space then m w.";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Power {
    Mains,
    Battery,
    Unknown,
}

/// `GUID_ACDC_POWER_SOURCE`'s payload: 0 is AC, 1 is DC, 2 is a short-term
/// source such as a UPS. A UPS is a battery for every purpose here — holding a
/// machine awake on one is how it runs flat during the outage.
pub(crate) fn power_from_source(data: u32) -> Power {
    match data {
        0 => Power::Mains,
        1 | 2 => Power::Battery,
        _ => Power::Unknown,
    }
}

/// `SYSTEM_POWER_STATUS.ACLineStatus`: 0 offline, 1 online, 255 unknown.
pub(crate) fn power_from_line(status: u8) -> Power {
    match status {
        0 => Power::Battery,
        1 => Power::Mains,
        _ => Power::Unknown,
    }
}

/// Whether the request should be held. Unknown power releases it: the cost of
/// guessing wrong in that direction is one sleep, and in the other a dead
/// battery.
pub(crate) fn holds(enabled: bool, power: Power) -> bool {
    enabled && power == Power::Mains
}

/// What closing the lid does while on mains, from the active power scheme.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Lid {
    /// There is no lid — a desktop, or a laptop that does not report one.
    Absent,
    Nothing,
    Sleep,
    Hibernate,
    Shutdown,
    Unknown,
}

pub(crate) fn lid_from_index(index: u32) -> Lid {
    match index {
        0 => Lid::Nothing,
        1 => Lid::Sleep,
        2 => Lid::Hibernate,
        3 => Lid::Shutdown,
        _ => Lid::Unknown,
    }
}

/// Whether Windows signs the last user back in after a restart (ARSO), as far
/// as this machine says. The front end decides what it means — see
/// `machine.ts`'s `comeback`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Arso {
    /// `DisableAutomaticRestartSignOn = 1`: an administrator has taken it away.
    pub policy_off: bool,
    /// Her own switch in Sign-in options. `None` when it has never been
    /// touched, which leaves it at Windows' default — and that default is not
    /// something this machine records anywhere we can read.
    pub user: Option<bool>,
    /// Joined to Active Directory or Entra ID. On such a machine ARSO covers
    /// Windows Update restarts only, and wants TPM 2.0, Secure Boot and
    /// BitLocker besides — Microsoft's rule, not hers and not ours.
    pub managed: bool,
}

/// The `Run` value's name. The studio is plain `Volery`, which is what Task
/// Manager's Startup tab shows her; a lab wall carries its identifier so two
/// never share an entry.
pub(crate) fn run_value_name(identifier: &str) -> String {
    if identifier == "dev.skein.studio" {
        "Volery".to_string()
    } else {
        format!("Volery ({identifier})")
    }
}

pub(crate) fn run_command(exe: &Path) -> String {
    format!("\"{}\" {FLAG_AUTOSTART}", exe.display())
}

/// Task Manager writes twelve bytes per entry; an odd first byte is switched
/// off (2 and 6 on, 3 and 7 off). Anything shorter is not a verdict.
pub(crate) fn startup_blocked(approved: &[u8]) -> bool {
    approved.first().is_some_and(|b| b & 1 == 1)
}

/// Whether this build may write the `Run` entry at all.
///
/// A debug build may not, unless `VOLERY_AUTOSTART=1` says it is being tested:
/// its exe is `target/debug`, whose front end is a vite server that will not be
/// running at sign-in, and it shares `dev.skein.studio` with the installed app —
/// so it would overwrite the installed wall's entry with one that opens blank.
pub(crate) fn owns_entry(debug: bool, env: Option<&str>) -> bool {
    !debug || env == Some("1")
}

fn owns() -> bool {
    owns_entry(
        cfg!(debug_assertions),
        std::env::var("VOLERY_AUTOSTART").ok().as_deref(),
    )
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// False off Windows, where none of this exists.
    pub supported: bool,
    /// The knob.
    pub awake: bool,
    pub power: Power,
    /// Whether the request is actually held right now.
    pub holding: bool,
    pub lid: Lid,
    /// The knob.
    pub reopen: bool,
    /// Whether this build writes the entry — see `owns_entry`.
    pub owns_entry: bool,
    /// Whether the `Run` entry exists right now.
    pub armed: bool,
    /// Switched off in Task Manager's Startup tab.
    pub startup_blocked: bool,
    pub arso: Arso,
}

struct Awake {
    enabled: bool,
    power: Power,
    /// The request's handle as an integer, 0 when none was made. A `HANDLE` is
    /// a raw pointer and not `Send`; the request outlives every thread that
    /// touches it, so the integer is all that needs keeping.
    request: isize,
    holding: bool,
}

static AWAKE: Mutex<Awake> = Mutex::new(Awake {
    enabled: true,
    power: Power::Unknown,
    request: 0,
    holding: false,
});
static APP: OnceLock<AppHandle> = OnceLock::new();
static IDENTIFIER: OnceLock<String> = OnceLock::new();

fn identifier() -> &'static str {
    IDENTIFIER.get().map(String::as_str).unwrap_or("dev.skein.studio")
}

/// Bring the request into line with the knob and the power source.
fn settle(st: &mut Awake) {
    let want = holds(st.enabled, st.power);
    if want == st.holding || st.request == 0 {
        return;
    }
    match os::hold(st.request, want) {
        Ok(()) => {
            st.holding = want;
            log::info!(
                "machine: {} the wake request ({:?})",
                if want { "holding" } else { "released" },
                st.power
            );
        }
        Err(e) => log::warn!("machine: could not change the wake request: {e}"),
    }
}

/// The power source changed. Called from the notification's own thread.
fn heard(power: Power) {
    {
        let Ok(mut st) = AWAKE.lock() else { return };
        if st.power == power {
            return;
        }
        st.power = power;
        settle(&mut st);
    }
    /* Outside the lock: `status` takes it again. */
    if let Some(app) = APP.get() {
        let _ = app.emit("machine:changed", status());
    }
}

/// Everything at launch: the wake request and its subscription, and the `Run`
/// entry brought into line with the knob. Called from `open_wall` before the
/// windows exist, because `machine_status` reads what this sets up.
pub fn arrive(app: &AppHandle) {
    let _ = APP.set(app.clone());
    let _ = IDENTIFIER.set(app.config().identifier.clone());
    let id = identifier();

    let enabled = os::read_knob(id, KNOB_AWAKE).unwrap_or(true);
    match os::make_request() {
        Ok(request) => {
            let mut st = AWAKE.lock().unwrap_or_else(|p| p.into_inner());
            st.enabled = enabled;
            st.request = request;
            /* Sampled once so the first answer is right even if the
               registration's own first callback is slow; every change after it
               arrives as an event. */
            st.power = os::sample_power();
            settle(&mut st);
        }
        Err(e) => log::warn!("machine: no wake request: {e}"),
    }
    if let Err(e) = os::subscribe_power() {
        log::warn!("machine: cannot hear the power source change: {e}");
    }

    if owns() {
        let result = if os::read_knob(id, KNOB_REOPEN).unwrap_or(true) {
            os::write_run(&run_value_name(id))
        } else {
            os::delete_run(&run_value_name(id))
        };
        if let Err(e) = result {
            log::warn!("machine: could not set the startup entry: {e}");
        }
    }
}

/// Somebody closed the studio: it was not open when Windows went down, so it
/// should not come back. Only ever called from the main window's close — see
/// the call site for why the exit handler must not.
pub fn leave() {
    if owns() {
        if let Err(e) = os::delete_run(&run_value_name(identifier())) {
            log::warn!("machine: could not remove the startup entry: {e}");
        }
    }
}

/// Give the request back on the way out. The kernel would on process death
/// anyway; this is the release being said rather than assumed.
pub fn release() {
    if let Ok(mut st) = AWAKE.lock() {
        if st.holding && st.request != 0 {
            let _ = os::hold(st.request, false);
            st.holding = false;
        }
    }
}

pub fn status() -> Status {
    let id = identifier();
    let (awake, power, holding) = AWAKE
        .lock()
        .map(|st| (st.enabled, st.power, st.holding))
        .unwrap_or((true, Power::Unknown, false));
    let name = run_value_name(id);
    Status {
        supported: os::SUPPORTED,
        awake,
        power,
        holding,
        lid: os::lid(),
        reopen: os::read_knob(id, KNOB_REOPEN).unwrap_or(true),
        owns_entry: owns(),
        armed: os::run_exists(&name),
        startup_blocked: os::startup_approved(&name).is_some_and(|b| startup_blocked(&b)),
        arso: os::arso(),
    }
}

fn set(knob: &str, on: bool) -> Result<Status, String> {
    if !os::SUPPORTED {
        return Err("keeping the machine awake and reopening after a restart are windows-only".into());
    }
    let id = identifier();
    match knob {
        "awake" => {
            os::write_knob(id, KNOB_AWAKE, on)?;
            let mut st = AWAKE.lock().map_err(|_| "the wake state is poisoned".to_string())?;
            st.enabled = on;
            settle(&mut st);
        }
        "reopen" => {
            os::write_knob(id, KNOB_REOPEN, on)?;
            /* The wall is open right now, so on means the entry exists from
               this moment — and off must remove it rather than orphan it. */
            if owns() {
                let name = run_value_name(id);
                if on {
                    os::write_run(&name)?;
                } else {
                    os::delete_run(&name)?;
                }
            }
        }
        other => return Err(format!("`{other}` is not a machine setting")),
    }
    Ok(status())
}

#[tauri::command]
pub async fn machine_status() -> Result<Status, String> {
    crate::off_main(status).await
}

#[tauri::command]
pub async fn machine_set(knob: String, on: bool) -> Result<Status, String> {
    crate::off_main(move || set(&knob, on)).await?
}

#[cfg(windows)]
mod os {
    use super::{lid_from_index, power_from_line, power_from_source, Arso, Lid, Power};
    use windows::core::{GUID, HSTRING, PWSTR};
    use windows::Win32::Foundation::{
        CloseHandle, LocalFree, ERROR_FILE_NOT_FOUND, ERROR_SUCCESS, HANDLE, HLOCAL,
    };
    use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
    use windows::Win32::System::Power::{
        GetPwrCapabilities, GetSystemPowerStatus, PowerClearRequest, PowerCreateRequest,
        PowerGetActiveScheme, PowerReadACValueIndex, PowerRequestSystemRequired, PowerSetRequest,
        PowerSettingRegisterNotification, DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS,
        POWERBROADCAST_SETTING, SYSTEM_POWER_CAPABILITIES, SYSTEM_POWER_STATUS,
    };
    use windows::Win32::System::Registry::{
        RegCloseKey, RegDeleteKeyValueW, RegGetValueW, RegOpenKeyExW, RegQueryInfoKeyW,
        RegSetKeyValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, REG_DWORD,
        REG_ROUTINE_FLAGS, REG_SZ, RRF_RT_REG_BINARY, RRF_RT_REG_DWORD, RRF_RT_REG_SZ,
    };
    use windows::Win32::System::SystemInformation::{ComputerNameDnsDomain, GetComputerNameExW};
    use windows::Win32::System::Threading::{
        GetCurrentProcess, OpenProcessToken, POWER_REQUEST_CONTEXT_SIMPLE_STRING, REASON_CONTEXT,
    };
    use windows::Win32::UI::WindowsAndMessaging::{DEVICE_NOTIFY_CALLBACK, PBT_POWERSETTINGCHANGE};

    pub const SUPPORTED: bool = true;

    /* Spelled here rather than taken from `Win32_System_SystemServices`, a
       feature the size of the rest of the crate for three GUIDs. Values from
       winnt.h. */
    const ACDC_POWER_SOURCE: GUID = GUID::from_u128(0x5d3e9a59_e9d5_4b00_a6bd_ff34ff516548);
    const SYSTEM_BUTTON_SUBGROUP: GUID = GUID::from_u128(0x4f971e89_eebd_4455_a8de_9e59040e7347);
    const LIDCLOSE_ACTION: GUID = GUID::from_u128(0x5ca83367_6e45_459f_a27b_476b1d01c936);

    pub fn make_request() -> Result<isize, String> {
        /* Leaked once, deliberately: the reason has to outlive the call, and
           there is one request per process. */
        let wide: &'static mut [u16] = Box::leak(
            super::REASON.encode_utf16().chain(Some(0)).collect::<Vec<_>>().into_boxed_slice(),
        );
        let mut context = REASON_CONTEXT {
            Version: 0, // POWER_REQUEST_CONTEXT_VERSION
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
                PowerSetRequest(handle, PowerRequestSystemRequired)
            } else {
                PowerClearRequest(handle, PowerRequestSystemRequired)
            }
        }
        .map_err(|e| e.to_string())
    }

    pub fn sample_power() -> Power {
        let mut status = SYSTEM_POWER_STATUS::default();
        // SAFETY: an out-pointer to a struct of the right size.
        match unsafe { GetSystemPowerStatus(&mut status) } {
            Ok(()) => power_from_line(status.ACLineStatus),
            Err(_) => Power::Unknown,
        }
    }

    unsafe extern "system" fn on_power(
        _context: *const core::ffi::c_void,
        kind: u32,
        setting: *const core::ffi::c_void,
    ) -> u32 {
        if kind == PBT_POWERSETTINGCHANGE && !setting.is_null() {
            // SAFETY: Windows hands a POWERBROADCAST_SETTING for this kind;
            // `Data` is `DataLength` bytes and may not be aligned.
            let s = unsafe { &*(setting as *const POWERBROADCAST_SETTING) };
            if s.PowerSetting == ACDC_POWER_SOURCE && s.DataLength >= 4 {
                let data = unsafe { std::ptr::read_unaligned(s.Data.as_ptr() as *const u32) };
                super::heard(power_from_source(data));
            }
        }
        0
    }

    pub fn subscribe_power() -> Result<(), String> {
        /* Leaked for the reason the request's reason is: the registration is
           for the life of the process and is never undone. */
        let params: &'static DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS =
            Box::leak(Box::new(DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS {
                Callback: Some(on_power),
                Context: std::ptr::null_mut(),
            }));
        let mut registration: *mut core::ffi::c_void = std::ptr::null_mut();
        // SAFETY: the GUID and the parameters outlive the registration.
        let result = unsafe {
            PowerSettingRegisterNotification(
                &ACDC_POWER_SOURCE,
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

    pub fn lid() -> Lid {
        let mut caps = SYSTEM_POWER_CAPABILITIES::default();
        // SAFETY: an out-pointer to a struct of the right size.
        if !unsafe { GetPwrCapabilities(&mut caps) } {
            return Lid::Unknown;
        }
        if !caps.LidPresent {
            return Lid::Absent;
        }
        let mut scheme: *mut GUID = std::ptr::null_mut();
        // SAFETY: Windows allocates the GUID and we free it below.
        if unsafe { PowerGetActiveScheme(None, &mut scheme) } != ERROR_SUCCESS || scheme.is_null() {
            return Lid::Unknown;
        }
        let mut index = u32::MAX;
        let read = unsafe {
            PowerReadACValueIndex(
                None,
                Some(scheme),
                Some(&SYSTEM_BUTTON_SUBGROUP),
                Some(&LIDCLOSE_ACTION),
                &mut index,
            )
        };
        unsafe { LocalFree(Some(HLOCAL(scheme as *mut core::ffi::c_void))) };
        if read == ERROR_SUCCESS {
            lid_from_index(index)
        } else {
            Lid::Unknown
        }
    }

    fn read_dword(root: HKEY, key: &str, name: &str) -> Option<u32> {
        let mut value = 0u32;
        let mut size = 4u32;
        // SAFETY: a DWORD-sized buffer and its size.
        let r = unsafe {
            RegGetValueW(
                root,
                &HSTRING::from(key),
                &HSTRING::from(name),
                RRF_RT_REG_DWORD,
                None,
                Some(&mut value as *mut u32 as *mut core::ffi::c_void),
                Some(&mut size),
            )
        };
        (r == ERROR_SUCCESS).then_some(value)
    }

    fn read_bytes(root: HKEY, key: &str, name: &str, flags: REG_ROUTINE_FLAGS) -> Option<Vec<u8>> {
        let (k, n) = (HSTRING::from(key), HSTRING::from(name));
        let mut size = 0u32;
        // SAFETY: a size query, then a buffer of that size.
        let r = unsafe { RegGetValueW(root, &k, &n, flags, None, None, Some(&mut size)) };
        if r != ERROR_SUCCESS {
            return None;
        }
        let mut buf = vec![0u8; size as usize];
        let r = unsafe {
            RegGetValueW(
                root,
                &k,
                &n,
                flags,
                None,
                Some(buf.as_mut_ptr() as *mut core::ffi::c_void),
                Some(&mut size),
            )
        };
        (r == ERROR_SUCCESS).then(|| {
            buf.truncate(size as usize);
            buf
        })
    }

    pub fn read_knob(identifier: &str, name: &str) -> Option<bool> {
        read_dword(HKEY_CURRENT_USER, &super::settings_key(identifier), name).map(|v| v != 0)
    }

    pub fn write_knob(identifier: &str, name: &str, on: bool) -> Result<(), String> {
        let value: u32 = on.into();
        // SAFETY: a DWORD and its size; the subkey is created if missing.
        let r = unsafe {
            RegSetKeyValueW(
                HKEY_CURRENT_USER,
                &HSTRING::from(super::settings_key(identifier)),
                &HSTRING::from(name),
                REG_DWORD.0,
                Some(&value as *const u32 as *const core::ffi::c_void),
                4,
            )
        };
        if r == ERROR_SUCCESS {
            Ok(())
        } else {
            Err(format!("could not save the setting (error {})", r.0))
        }
    }

    pub fn write_run(name: &str) -> Result<(), String> {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let wide: Vec<u16> = super::run_command(&exe).encode_utf16().chain(Some(0)).collect();
        // SAFETY: a null-terminated wide string and its size in bytes.
        let r = unsafe {
            RegSetKeyValueW(
                HKEY_CURRENT_USER,
                &HSTRING::from(super::RUN_KEY),
                &HSTRING::from(name),
                REG_SZ.0,
                Some(wide.as_ptr() as *const core::ffi::c_void),
                (wide.len() * 2) as u32,
            )
        };
        if r == ERROR_SUCCESS {
            Ok(())
        } else {
            Err(format!("could not write the startup entry (error {})", r.0))
        }
    }

    pub fn delete_run(name: &str) -> Result<(), String> {
        // SAFETY: two wide strings that outlive the call.
        let r = unsafe {
            RegDeleteKeyValueW(
                HKEY_CURRENT_USER,
                &HSTRING::from(super::RUN_KEY),
                &HSTRING::from(name),
            )
        };
        if r == ERROR_SUCCESS || r == ERROR_FILE_NOT_FOUND {
            Ok(())
        } else {
            Err(format!("could not remove the startup entry (error {})", r.0))
        }
    }

    pub fn run_exists(name: &str) -> bool {
        read_bytes(HKEY_CURRENT_USER, super::RUN_KEY, name, RRF_RT_REG_SZ).is_some()
    }

    pub fn startup_approved(name: &str) -> Option<Vec<u8>> {
        read_bytes(HKEY_CURRENT_USER, super::APPROVED_KEY, name, RRF_RT_REG_BINARY)
    }

    fn subkeys(root: HKEY, key: &str) -> u32 {
        let mut hkey = HKEY::default();
        // SAFETY: an out-pointer for the opened key, closed below.
        if unsafe { RegOpenKeyExW(root, &HSTRING::from(key), None, KEY_READ, &mut hkey) }
            != ERROR_SUCCESS
        {
            return 0;
        }
        let mut count = 0u32;
        unsafe {
            let _ = RegQueryInfoKeyW(
                hkey,
                None,
                None,
                None,
                Some(&mut count),
                None,
                None,
                None,
                None,
                None,
                None,
                None,
            );
            let _ = RegCloseKey(hkey);
        }
        count
    }

    /// The signed-in user's SID as a string, which is what `UserARSO` is keyed
    /// on.
    fn user_sid() -> Option<String> {
        let mut token = HANDLE::default();
        // SAFETY: our own process token, closed below; the buffer is sized by
        // the first call.
        unsafe {
            OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).ok()?;
            let mut size = 0u32;
            let _ = GetTokenInformation(token, TokenUser, None, 0, &mut size);
            let mut buf = vec![0u8; size as usize];
            let got = GetTokenInformation(
                token,
                TokenUser,
                Some(buf.as_mut_ptr() as *mut core::ffi::c_void),
                size,
                &mut size,
            );
            let _ = CloseHandle(token);
            got.ok()?;
            let user = &*(buf.as_ptr() as *const TOKEN_USER);
            let mut text = PWSTR::null();
            ConvertSidToStringSidW(user.User.Sid, &mut text).ok()?;
            let sid = text.to_string().ok();
            LocalFree(Some(HLOCAL(text.0 as *mut core::ffi::c_void)));
            sid
        }
    }

    /// Joined to Active Directory (a DNS domain) or to Entra ID (a JoinInfo
    /// entry). Workplace *registration* — adding a work account to a personal
    /// machine — writes neither, and does not make a machine managed.
    fn managed() -> bool {
        if subkeys(
            HKEY_LOCAL_MACHINE,
            "SYSTEM\\CurrentControlSet\\Control\\CloudDomainJoin\\JoinInfo",
        ) > 0
        {
            return true;
        }
        let mut size = 0u32;
        // SAFETY: a size query, then a buffer of that size.
        unsafe {
            let _ = GetComputerNameExW(ComputerNameDnsDomain, None, &mut size);
            if size <= 1 {
                return false;
            }
            let mut buf = vec![0u16; size as usize];
            if GetComputerNameExW(ComputerNameDnsDomain, Some(PWSTR(buf.as_mut_ptr())), &mut size)
                .is_err()
            {
                return false;
            }
            size > 0
        }
    }

    pub fn arso() -> Arso {
        const POLICY: &str = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System";
        let policy_off =
            read_dword(HKEY_LOCAL_MACHINE, POLICY, "DisableAutomaticRestartSignOn") == Some(1);
        let user = user_sid().and_then(|sid| {
            read_dword(
                HKEY_LOCAL_MACHINE,
                &format!("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon\\UserARSO\\{sid}"),
                "OptOut",
            )
        });
        Arso {
            policy_off,
            user: user.map(|opt_out| opt_out == 0),
            managed: managed(),
        }
    }
}

/// Off Windows there is no machine to ask anything of. The status says so
/// (`supported: false`) and every write is an error rather than a silent
/// no-op, which is the house rule for a capability.
#[cfg(not(windows))]
mod os {
    use super::{Arso, Lid, Power};

    pub const SUPPORTED: bool = false;

    pub fn make_request() -> Result<isize, String> {
        Err("power requests are windows-only".into())
    }
    pub fn hold(_: isize, _: bool) -> Result<(), String> {
        Err("power requests are windows-only".into())
    }
    pub fn sample_power() -> Power {
        Power::Unknown
    }
    pub fn subscribe_power() -> Result<(), String> {
        Err("power notifications are windows-only".into())
    }
    pub fn lid() -> Lid {
        Lid::Unknown
    }
    pub fn read_knob(_: &str, _: &str) -> Option<bool> {
        None
    }
    pub fn write_knob(_: &str, _: &str, _: bool) -> Result<(), String> {
        Err("machine settings are windows-only".into())
    }
    pub fn write_run(_: &str) -> Result<(), String> {
        Err("reopening after a restart is windows-only".into())
    }
    pub fn delete_run(_: &str) -> Result<(), String> {
        Ok(())
    }
    pub fn run_exists(_: &str) -> bool {
        false
    }
    pub fn startup_approved(_: &str) -> Option<Vec<u8>> {
        None
    }
    pub fn arso() -> Arso {
        Arso::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_mains_holds_the_machine_awake() {
        assert!(holds(true, Power::Mains));
        assert!(!holds(true, Power::Battery));
        /* Unknown releases: a missed sleep is cheaper than a flat battery. */
        assert!(!holds(true, Power::Unknown));
        assert!(!holds(false, Power::Mains));
    }

    #[test]
    fn a_ups_is_a_battery() {
        assert_eq!(power_from_source(0), Power::Mains);
        assert_eq!(power_from_source(1), Power::Battery);
        assert_eq!(power_from_source(2), Power::Battery);
        assert_eq!(power_from_source(7), Power::Unknown);
        assert_eq!(power_from_line(1), Power::Mains);
        assert_eq!(power_from_line(0), Power::Battery);
        assert_eq!(power_from_line(255), Power::Unknown);
    }

    #[test]
    fn the_lid_action_reads_as_windows_numbers_it() {
        assert_eq!(lid_from_index(0), Lid::Nothing);
        assert_eq!(lid_from_index(1), Lid::Sleep);
        assert_eq!(lid_from_index(2), Lid::Hibernate);
        assert_eq!(lid_from_index(3), Lid::Shutdown);
        assert_eq!(lid_from_index(9), Lid::Unknown);
    }

    #[test]
    fn the_studio_and_a_lab_never_share_a_startup_entry() {
        assert_eq!(run_value_name("dev.skein.studio"), "Volery");
        assert_eq!(run_value_name("dev.skein.lab.a"), "Volery (dev.skein.lab.a)");
        assert_ne!(run_value_name("dev.skein.lab"), run_value_name("dev.skein.studio"));
    }

    #[test]
    fn the_startup_entry_launches_with_the_flag_intercept_lets_through() {
        let cmd = run_command(Path::new(r"C:\Program Files\Volery\skein.exe"));
        assert_eq!(cmd, r#""C:\Program Files\Volery\skein.exe" --autostart"#);
        assert!(cmd.ends_with(FLAG_AUTOSTART));
    }

    #[test]
    fn task_manager_switching_it_off_is_read_as_off() {
        assert!(!startup_blocked(&[2, 0, 0, 0]));
        assert!(!startup_blocked(&[6, 0, 0, 0]));
        assert!(startup_blocked(&[3, 0, 0, 0]));
        assert!(startup_blocked(&[7, 0, 0, 0]));
        assert!(!startup_blocked(&[]));
    }

    #[test]
    fn a_debug_build_leaves_the_installed_wall_s_entry_alone() {
        assert!(owns_entry(false, None));
        assert!(!owns_entry(true, None));
        assert!(!owns_entry(true, Some("0")));
        assert!(owns_entry(true, Some("1")));
    }
}
