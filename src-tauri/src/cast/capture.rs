//! Desktop Duplication of one output, on the adapter that owns it.
//!
//! Each acquired frame is copied into a texture of our own (`latest`) and the
//! duplication frame released at once: holding DXGI's frame stalls DWM's
//! hand-off of the next one, and keeping our own copy is what lets a
//! keyframe be encoded for a joining viewer while the screen is perfectly
//! still and DXGI has nothing new to say.
//!
//! The pointer is never in the image — DXGI hands its shape and position
//! separately, and the viewer draws it (`docs/SCREENS.md`: the local pointer
//! moves at the viewer's own refresh rate whatever the stream is doing).
//! `straight_rgba` turns DXGI's three shape formats into the one the wire
//! carries; it is pure and tested.
//!
//! `DXGI_ERROR_ACCESS_LOST` is a mode change, a full-screen app taking the
//! output, or the secure desktop (lock, UAC, Ctrl+Alt+Del). All three are
//! answered the same way: drop the duplication and make a new one, which
//! fails with `E_ACCESSDENIED` for as long as the secure desktop holds the
//! input. The hub reads that as `locked`.

/// DXGI_OUTDUPL_POINTER_SHAPE_TYPE.
pub const SHAPE_MONOCHROME: u32 = 1;
pub const SHAPE_COLOR: u32 = 2;
pub const SHAPE_MASKED_COLOR: u32 = 4;

/// A pointer image, ready for `wire::cursor_shape`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cursor {
    pub w: u16,
    pub h: u16,
    pub hot_x: u16,
    pub hot_y: u16,
    /// Straight-alpha RGBA, `w * h * 4`.
    pub rgba: Vec<u8>,
    /// A hash of the image, so a viewer that has seen a shape is only told
    /// its number again.
    pub id: u32,
}

fn fnv(bytes: &[u8]) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for &b in bytes {
        h ^= b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

/// An inverting pixel cannot be drawn by a viewer that composites rather than
/// XORs. Black reads on the light ground most desktops are; it is what most
/// remote desktops pick, and the I-beam — the cursor that is nearly all
/// inversion — stays visible over text.
const INVERT: [u8; 4] = [0, 0, 0, 255];

/// DXGI's pointer shape buffer → straight-alpha RGBA.
///
/// - monochrome: 1bpp AND mask over 1bpp XOR mask, `height` is both, so the
///   image is half of it. AND 1/XOR 0 is transparent, 0/0 black, 0/1 white,
///   1/1 inverts the screen.
/// - colour: 32bpp BGRA. Windows hands it premultiplied when every channel is
///   at most its alpha, which a straight image with any antialiasing is not;
///   unpremultiplied only then.
/// - masked colour: 32bpp, the alpha byte a mask — 0 means "this colour", 0xFF
///   means "XOR the screen with this colour", where black is transparent.
pub fn straight_rgba(kind: u32, w: u32, h: u32, pitch: u32, buf: &[u8]) -> Option<(u32, u32, Vec<u8>)> {
    let (w, pitch) = (w as usize, pitch as usize);
    match kind {
        SHAPE_MONOCHROME => {
            let h = h as usize / 2;
            if buf.len() < pitch * h * 2 {
                return None;
            }
            let mut out = vec![0u8; w * h * 4];
            for y in 0..h {
                for x in 0..w {
                    let bit = 0x80 >> (x % 8);
                    let and = buf[y * pitch + x / 8] & bit != 0;
                    let xor = buf[(y + h) * pitch + x / 8] & bit != 0;
                    let px = match (and, xor) {
                        (true, false) => [0, 0, 0, 0],
                        (false, false) => [0, 0, 0, 255],
                        (false, true) => [255, 255, 255, 255],
                        (true, true) => INVERT,
                    };
                    out[(y * w + x) * 4..][..4].copy_from_slice(&px);
                }
            }
            Some((w as u32, h as u32, out))
        }
        SHAPE_COLOR | SHAPE_MASKED_COLOR => {
            let h = h as usize;
            if buf.len() < pitch * h || pitch < w * 4 {
                return None;
            }
            let row = |y: usize| &buf[y * pitch..y * pitch + w * 4];
            let premultiplied = kind == SHAPE_COLOR
                && (0..h).all(|y| row(y).chunks_exact(4).all(|p| p[0] <= p[3] && p[1] <= p[3] && p[2] <= p[3]));
            let mut out = vec![0u8; w * h * 4];
            for y in 0..h {
                for (x, p) in row(y).chunks_exact(4).enumerate() {
                    let (b, g, r, a) = (p[0], p[1], p[2], p[3]);
                    let px = if kind == SHAPE_MASKED_COLOR {
                        match (a, r | g | b) {
                            (0, _) => [r, g, b, 255],
                            (_, 0) => [0, 0, 0, 0],
                            _ if (r, g, b) == (255, 255, 255) => INVERT,
                            _ => [r, g, b, 255],
                        }
                    } else if premultiplied && a > 0 && a < 255 {
                        let un = |c: u8| ((c as u32 * 255 + a as u32 / 2) / a as u32).min(255) as u8;
                        [un(r), un(g), un(b), a]
                    } else {
                        [r, g, b, a]
                    };
                    out[(y * w + x) * 4..][..4].copy_from_slice(&px);
                }
            }
            Some((w as u32, h as u32, out))
        }
        _ => None,
    }
}

pub fn cursor(kind: u32, w: u32, h: u32, pitch: u32, hot: (i32, i32), buf: &[u8]) -> Option<Cursor> {
    let (w, h, rgba) = straight_rgba(kind, w, h, pitch, buf)?;
    if w == 0 || h == 0 || w > u16::MAX as u32 || h > u16::MAX as u32 {
        return None;
    }
    let id = fnv(&rgba) ^ fnv(&[w as u8, h as u8, hot.0 as u8, hot.1 as u8]);
    Some(Cursor { w: w as u16, h: h as u16, hot_x: hot.0.max(0) as u16, hot_y: hot.1.max(0) as u16, rgba, id })
}

/// Where the pointer is, in source pixels from the output's top-left.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Pointer {
    pub visible: bool,
    pub x: i32,
    pub y: i32,
}

#[cfg(windows)]
pub use os::*;

#[cfg(windows)]
mod os {
    use super::{cursor, Cursor, Pointer};
    use crate::cast::gpu::Gpu;
    use std::sync::Arc;
    use std::time::Instant;
    use windows::core::Interface;
    use windows::Win32::Foundation::E_ACCESSDENIED;
    use windows::Win32::Graphics::Direct3D11::{ID3D11Texture2D, D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE};
    use windows::Win32::Graphics::Dxgi::Common::*;
    use windows::Win32::Graphics::Dxgi::*;

    /// One acquire's worth of news.
    pub struct Tick {
        /// `latest` holds a new image.
        pub frame: bool,
        /// When the acquire returned, which is as close to the capture as
        /// user mode gets.
        pub at: Instant,
        pub wall_us: u64,
        pub pointer: Option<Pointer>,
        pub shape: Option<Cursor>,
    }

    pub enum Lost {
        /// Make a new duplication (and say `locked` while that fails with
        /// access denied).
        Access,
        Other(String),
    }

    /// A 1ms system timer for as long as it is held.
    ///
    /// Measured on the hybrid laptop: with the default 15.6ms tick every frame
    /// spent a whole multiple of 15.6ms inside Intel's encoder MFT under
    /// continuous feed (15, 30, 46, 61ms — never between), while a lone frame
    /// after a rest came back in 8ms. Something on the driver's path waits on
    /// the coarse timer. Windows 11 scopes the resolution to the process that
    /// asked, and only while it asks, so this is held by each capture thread
    /// and costs nothing once the last screen closes.
    pub struct FineTimer(());

    impl FineTimer {
        pub fn hold() -> FineTimer {
            unsafe { windows::Win32::Media::timeBeginPeriod(1) };
            FineTimer(())
        }
    }

    impl Drop for FineTimer {
        fn drop(&mut self) {
            unsafe { windows::Win32::Media::timeEndPeriod(1) };
        }
    }

    pub fn wall_us() -> u64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_micros() as u64).unwrap_or(0)
    }

    pub struct Duplicator {
        pub gpu: Arc<Gpu>,
        output: IDXGIOutput1,
        dup: Option<IDXGIOutputDuplication>,
        /// The desktop as of the last frame, BGRA at native size.
        pub latest: ID3D11Texture2D,
        pub size: (u32, u32),
        shape_buf: Vec<u8>,
        /// The last pointer position, so a shape-only update still has one.
        pointer: Pointer,
    }

    unsafe impl Send for Duplicator {}

    pub enum Opened {
        Ok(Duplicator),
        /// The secure desktop has the output.
        Locked,
        Failed(String),
    }

    fn duplicate(gpu: &Gpu, output: &IDXGIOutput1) -> windows::core::Result<IDXGIOutputDuplication> {
        /* DuplicateOutput1 asks for BGRA, so an HDR or wide-gamut desktop is
           tone-mapped by DWM rather than handed to us as FP16. It needs a
           per-monitor-aware process, which the app is and the probe makes
           itself; the plain call is the fallback. */
        if let Ok(o5) = output.cast::<IDXGIOutput5>() {
            if let Ok(d) = unsafe { o5.DuplicateOutput1(&gpu.device, 0, &[DXGI_FORMAT_B8G8R8A8_UNORM]) } {
                return Ok(d);
            }
        }
        unsafe { output.DuplicateOutput(&gpu.device) }
    }

    impl Duplicator {
        pub fn open(gpu: Arc<Gpu>, output: IDXGIOutput1) -> Opened {
            let dup = match duplicate(&gpu, &output) {
                Ok(d) => d,
                Err(e) if e.code() == E_ACCESSDENIED => return Opened::Locked,
                Err(e) => return Opened::Failed(format!("duplicating the output: {e}")),
            };
            let desc = unsafe { dup.GetDesc() };
            let size = (desc.ModeDesc.Width, desc.ModeDesc.Height);
            let latest = match gpu.texture(size.0, size.1, DXGI_FORMAT_B8G8R8A8_UNORM, D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE) {
                Ok(t) => t,
                Err(e) => return Opened::Failed(format!("a texture for the desktop: {e}")),
            };
            Opened::Ok(Duplicator {
                gpu,
                output,
                dup: Some(dup),
                latest,
                size,
                shape_buf: Vec::new(),
                pointer: Pointer { visible: false, x: 0, y: 0 },
            })
        }

        /// Try to duplicate again after `Lost::Access`. `Ok(false)` while the
        /// secure desktop still has it. A changed size is a mode change: the
        /// caller rebuilds what scales from `latest`.
        pub fn reopen(&mut self) -> Result<bool, String> {
            self.dup = None;
            match duplicate(&self.gpu, &self.output) {
                Ok(d) => {
                    let desc = unsafe { d.GetDesc() };
                    let size = (desc.ModeDesc.Width, desc.ModeDesc.Height);
                    if size != self.size {
                        self.latest = self
                            .gpu
                            .texture(size.0, size.1, DXGI_FORMAT_B8G8R8A8_UNORM, D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE)
                            .map_err(|e| e.to_string())?;
                        self.size = size;
                    }
                    self.dup = Some(d);
                    Ok(true)
                }
                Err(e) if e.code() == E_ACCESSDENIED => Ok(false),
                Err(e) => Err(e.to_string()),
            }
        }

        /// Wait up to `timeout_ms` for the desktop or the pointer to change.
        pub fn next(&mut self, timeout_ms: u32) -> Result<Option<Tick>, Lost> {
            let Some(dup) = self.dup.clone() else { return Err(Lost::Access) };
            let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
            let mut resource = None;
            match unsafe { dup.AcquireNextFrame(timeout_ms, &mut info, &mut resource) } {
                Ok(()) => {}
                Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => return Ok(None),
                Err(e) if e.code() == DXGI_ERROR_ACCESS_LOST || e.code() == E_ACCESSDENIED => return Err(Lost::Access),
                Err(e) => return Err(Lost::Other(e.to_string())),
            }
            let at = Instant::now();
            let wall_us = wall_us();
            let frame = info.LastPresentTime != 0 && info.AccumulatedFrames > 0;
            if frame {
                if let Some(t) = resource.as_ref().and_then(|r| r.cast::<ID3D11Texture2D>().ok()) {
                    unsafe { self.gpu.context.CopyResource(&self.latest, &t) };
                }
            }
            let mut pointer = None;
            if info.LastMouseUpdateTime != 0 {
                let p = Pointer {
                    visible: info.PointerPosition.Visible.as_bool(),
                    x: info.PointerPosition.Position.x,
                    y: info.PointerPosition.Position.y,
                };
                if p != self.pointer {
                    self.pointer = p;
                    pointer = Some(p);
                }
            }
            let mut shape = None;
            if info.PointerShapeBufferSize > 0 {
                self.shape_buf.resize(info.PointerShapeBufferSize as usize, 0);
                let mut needed = 0u32;
                let mut si = DXGI_OUTDUPL_POINTER_SHAPE_INFO::default();
                let ok = unsafe {
                    dup.GetFramePointerShape(self.shape_buf.len() as u32, self.shape_buf.as_mut_ptr() as *mut _, &mut needed, &mut si)
                };
                if ok.is_ok() {
                    shape = cursor(si.Type, si.Width, si.Height, si.Pitch, (si.HotSpot.x, si.HotSpot.y), &self.shape_buf[..needed as usize]);
                }
            }
            drop(resource);
            unsafe {
                let _ = dup.ReleaseFrame();
            }
            Ok(Some(Tick { frame, at, wall_us, pointer, shape }))
        }

        pub fn pointer(&self) -> Pointer {
            self.pointer
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_monochrome_pointer_reads_all_four_mask_combinations() {
        // 4 pixels wide, 1 high: AND row then XOR row, one byte each.
        // pixel: 0 → AND1 XOR0, 1 → AND0 XOR0, 2 → AND0 XOR1, 3 → AND1 XOR1
        let buf = [0b1001_0000, 0b0011_0000];
        let (w, h, px) = straight_rgba(SHAPE_MONOCHROME, 4, 2, 1, &buf).unwrap();
        assert_eq!((w, h), (4, 1));
        assert_eq!(
            px,
            [0, 0, 0, 0, /**/ 0, 0, 0, 255, /**/ 255, 255, 255, 255, /**/ 0, 0, 0, 255]
        );
    }

    #[test]
    fn a_premultiplied_colour_pointer_is_unpremultiplied_and_a_straight_one_is_left() {
        // BGRA: half-alpha white premultiplied is 128,128,128,128.
        let pre = [128, 128, 128, 128, 0, 0, 0, 255];
        let (_, _, px) = straight_rgba(SHAPE_COLOR, 2, 1, 8, &pre).unwrap();
        assert_eq!(&px[..4], &[255, 255, 255, 128]);
        // A straight antialiased edge: white at half alpha.
        let straight = [255, 255, 255, 128, 0, 0, 0, 255];
        let (_, _, px) = straight_rgba(SHAPE_COLOR, 2, 1, 8, &straight).unwrap();
        assert_eq!(&px[..4], &[255, 255, 255, 128]);
        // BGRA order becomes RGBA.
        let blue = [255, 0, 0, 255];
        assert_eq!(straight_rgba(SHAPE_COLOR, 1, 1, 4, &blue).unwrap().2, [0, 0, 255, 255]);
    }

    #[test]
    fn a_masked_colour_pointer_keeps_its_colour_and_drops_its_transparent_xor() {
        let buf = [
            10, 20, 30, 0, // replace: opaque colour
            0, 0, 0, 255, // XOR with black: transparent
            255, 255, 255, 255, // XOR with white: inversion, drawn black
        ];
        let (_, _, px) = straight_rgba(SHAPE_MASKED_COLOR, 3, 1, 12, &buf).unwrap();
        assert_eq!(px, [30, 20, 10, 255, 0, 0, 0, 0, 0, 0, 0, 255]);
    }

    #[test]
    fn a_short_buffer_is_refused_and_ids_follow_the_image() {
        assert_eq!(straight_rgba(SHAPE_COLOR, 4, 4, 16, &[0; 10]), None);
        let a = cursor(SHAPE_COLOR, 1, 1, 4, (0, 0), &[1, 2, 3, 255]).unwrap();
        let b = cursor(SHAPE_COLOR, 1, 1, 4, (0, 0), &[1, 2, 4, 255]).unwrap();
        assert_ne!(a.id, b.id);
        assert_eq!(a.id, cursor(SHAPE_COLOR, 1, 1, 4, (0, 0), &[1, 2, 3, 255]).unwrap().id);
    }
}
