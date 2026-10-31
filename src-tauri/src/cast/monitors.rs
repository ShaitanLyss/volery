//! The monitors this machine can show, named so that a name leads straight
//! back to the adapter that has to duplicate it.
//!
//! An id is `<adapter LUID, 16 hex>-<output index>`. Not the GDI device name
//! (`\\.\DISPLAY1`), which renumbers when a monitor is plugged in, and not the
//! EDID, which two identical panels share. A LUID is assigned per boot, so an
//! id is good for as long as the monitor stays plugged in — which is as long
//! as any tile showing it can be — and it carries the one fact capture needs
//! first: *which adapter*. On a hybrid laptop the panel belongs to the iGPU and
//! duplicating it from the discrete card fails (`gpu.rs`).

use super::Monitor;

/// Parse an id back into its adapter LUID and output index.
pub fn parse_id(id: &str) -> Option<(u64, u32)> {
    let (luid, index) = id.split_once('-')?;
    (luid.len() == 16).then_some(())?;
    Some((u64::from_str_radix(luid, 16).ok()?, index.parse().ok()?))
}

pub fn make_id(luid: u64, index: u32) -> String {
    format!("{luid:016x}-{index}")
}

#[cfg(windows)]
pub use os::*;

#[cfg(windows)]
mod os {
    use super::{make_id, parse_id, Monitor};
    use crate::cast::gpu;
    use windows::core::{Interface, PCWSTR};
    use windows::Win32::Graphics::Dxgi::*;
    use windows::Win32::Graphics::Gdi::{EnumDisplayDevicesW, EnumDisplaySettingsW, DEVMODEW, DISPLAY_DEVICEW, ENUM_CURRENT_SETTINGS};

    fn wide(s: &[u16]) -> String {
        let end = s.iter().position(|&c| c == 0).unwrap_or(s.len());
        String::from_utf16_lossy(&s[..end])
    }

    /// What Windows calls the monitor behind a GDI device name: the first
    /// child device's string ("Generic PnP Monitor", or the panel's own name).
    fn friendly(device: &[u16; 32]) -> Option<String> {
        let mut dd = DISPLAY_DEVICEW { cb: std::mem::size_of::<DISPLAY_DEVICEW>() as u32, ..Default::default() };
        unsafe { EnumDisplayDevicesW(PCWSTR(device.as_ptr()), 0, &mut dd, 0) }.as_bool().then(|| wide(&dd.DeviceString))
    }

    fn refresh(device: &[u16; 32]) -> u32 {
        let mut dm = DEVMODEW { dmSize: std::mem::size_of::<DEVMODEW>() as u16, ..Default::default() };
        if unsafe { EnumDisplaySettingsW(PCWSTR(device.as_ptr()), ENUM_CURRENT_SETTINGS, &mut dm) }.as_bool() {
            dm.dmDisplayFrequency.max(1)
        } else {
            60
        }
    }

    /// Every output attached to the desktop, on every adapter. A few
    /// milliseconds of DXGI and GDI; not cached, since a plug or a mode change
    /// is exactly what a fresh read is for.
    pub fn list() -> Vec<Monitor> {
        let mut out = Vec::new();
        let Ok(adapters) = gpu::adapters() else { return out };
        for a in adapters {
            let Ok(desc) = (unsafe { a.GetDesc1() }) else { continue };
            let luid = gpu::luid64(desc.AdapterLuid);
            for i in 0.. {
                let output = match unsafe { a.EnumOutputs(i) } {
                    Ok(o) => o,
                    Err(_) => break,
                };
                let Ok(d) = (unsafe { output.GetDesc() }) else { continue };
                if !d.AttachedToDesktop.as_bool() {
                    continue;
                }
                let r = d.DesktopCoordinates;
                out.push(Monitor {
                    id: make_id(luid, i),
                    name: friendly(&d.DeviceName).filter(|s| !s.is_empty()).unwrap_or_else(|| wide(&d.DeviceName)),
                    w: (r.right - r.left) as u32,
                    h: (r.bottom - r.top) as u32,
                    x: r.left,
                    y: r.top,
                    hz: refresh(&d.DeviceName),
                    primary: r.left == 0 && r.top == 0,
                });
            }
        }
        out
    }

    /// The adapter and output an id names, as capture needs them.
    pub fn open(id: &str) -> Result<(IDXGIAdapter1, IDXGIOutput1), String> {
        let (luid, index) = parse_id(id).ok_or_else(|| format!("not a monitor id: {id}"))?;
        let adapter = gpu::adapter_by_luid(luid).map_err(|_| "that monitor's adapter is gone".to_string())?;
        let output = unsafe { adapter.EnumOutputs(index) }.map_err(|_| "that monitor is unplugged".to_string())?;
        let output: IDXGIOutput1 = output.cast().map_err(|e| e.to_string())?;
        Ok((adapter, output))
    }
}

#[cfg(not(windows))]
pub fn list() -> Vec<Monitor> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_id_round_trips_and_a_stranger_does_not_parse() {
        let id = make_id(0x0000_0001_0000_d2f1, 2);
        assert_eq!(id, "000000010000d2f1-2");
        assert_eq!(parse_id(&id), Some((0x0000_0001_0000_d2f1, 2)));
        assert_eq!(parse_id("DISPLAY1"), None);
        assert_eq!(parse_id("d2f1-0"), None);
    }
}
