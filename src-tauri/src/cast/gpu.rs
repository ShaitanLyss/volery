//! One D3D11 device per adapter, and the video processor that turns a
//! captured BGRA desktop into the NV12 an encoder takes, at the size a tile
//! wants — both on the GPU, so a frame never visits system memory.
//!
//! **The device must be the one on the adapter that owns the output.** Desktop
//! Duplication refuses a device on any other adapter (`DXGI_ERROR_UNSUPPORTED`),
//! and on a hybrid laptop that is the trap: the panel is driven by the iGPU
//! while the discrete card is headless, so "the best GPU" is the wrong one.
//! `monitors.rs` names a monitor by its adapter's LUID for exactly this reason.
//!
//! The device is multithread-protected because Media Foundation's encoder
//! reads the textures it is handed from its own work queue while the capture
//! thread is already converting the next frame.

use windows::core::{Interface, Result};
use windows::Win32::Foundation::{HMODULE, LUID, RECT};
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_UNKNOWN, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::*;
use windows::Win32::Graphics::Dxgi::*;
use windows::Win32::Media::MediaFoundation::{IMFDXGIDeviceManager, MFCreateDXGIDeviceManager};

/// A LUID as one number: what a monitor id and an encoder are matched on.
pub fn luid64(l: LUID) -> u64 {
    ((l.HighPart as u32 as u64) << 32) | l.LowPart as u64
}

pub fn factory() -> Result<IDXGIFactory1> {
    // SAFETY: plain factory creation.
    unsafe { CreateDXGIFactory1() }
}

/// Every adapter, software ones included; callers skip what has no outputs.
pub fn adapters() -> Result<Vec<IDXGIAdapter1>> {
    let f = factory()?;
    let mut out = Vec::new();
    for i in 0.. {
        match unsafe { f.EnumAdapters1(i) } {
            Ok(a) => out.push(a),
            Err(e) if e.code() == DXGI_ERROR_NOT_FOUND => break,
            Err(e) => return Err(e),
        }
    }
    Ok(out)
}

pub fn adapter_by_luid(luid: u64) -> Result<IDXGIAdapter1> {
    for a in adapters()? {
        if luid64(unsafe { a.GetDesc1()? }.AdapterLuid) == luid {
            return Ok(a);
        }
    }
    Err(windows::core::Error::new(DXGI_ERROR_NOT_FOUND, "no adapter with that LUID"))
}

pub fn adapter_name(a: &IDXGIAdapter1) -> String {
    unsafe { a.GetDesc1() }
        .map(|d| String::from_utf16_lossy(&d.Description).trim_end_matches('\0').to_string())
        .unwrap_or_default()
}

/// A device on one adapter, with what the encoder needs to share it.
pub struct Gpu {
    pub device: ID3D11Device,
    pub context: ID3D11DeviceContext,
    pub video: ID3D11VideoDevice,
    pub video_context: ID3D11VideoContext,
    /// Media Foundation's handle on the same device, so the encoder reads our
    /// NV12 textures where they are.
    pub manager: IMFDXGIDeviceManager,
    pub luid: u64,
    pub name: String,
}

// SAFETY: a D3D11 device is free-threaded, the immediate context is
// multithread-protected below, and every thread that touches these has
// joined the MTA.
unsafe impl Send for Gpu {}
unsafe impl Sync for Gpu {}

impl Gpu {
    pub fn open(adapter: &IDXGIAdapter1) -> Result<Gpu> {
        let desc = unsafe { adapter.GetDesc1()? };
        let mut device = None;
        let mut context = None;
        unsafe {
            D3D11CreateDevice(
                adapter,
                D3D_DRIVER_TYPE_UNKNOWN,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
                Some(&[D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0]),
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )?;
        }
        let device = device.expect("D3D11CreateDevice succeeded without a device");
        let context = context.expect("D3D11CreateDevice succeeded without a context");
        let mt: ID3D11Multithread = device.cast()?;
        unsafe {
            let _ = mt.SetMultithreadProtected(true);
        }
        /* The iGPU that owns the panel is also drawing the wall, every browser
           and DWM; measured on the hybrid laptop its 3D engine sat at ~100%
           and a frame's conversion queued ~30ms behind them. A raised GPU
           thread priority is the scheduler's own answer to "this work is
           latency-bound" — see the Probe section of docs/SCREENS.md. */
        if let Ok(d) = device.cast::<IDXGIDevice>() {
            let r = unsafe { d.SetGPUThreadPriority(7) };
            if let Err(e) = r {
                log::info!("cast: SetGPUThreadPriority(7) refused: {e}");
            }
        }
        let video: ID3D11VideoDevice = device.cast()?;
        let video_context: ID3D11VideoContext = context.cast()?;
        let mut token = 0u32;
        let mut manager = None;
        unsafe {
            MFCreateDXGIDeviceManager(&mut token, &mut manager)?;
        }
        let manager = manager.expect("MFCreateDXGIDeviceManager succeeded without a manager");
        unsafe { manager.ResetDevice(&device, token)? };
        Ok(Gpu {
            device,
            context,
            video,
            video_context,
            manager,
            luid: luid64(desc.AdapterLuid),
            name: String::from_utf16_lossy(&desc.Description).trim_end_matches('\0').to_string(),
        })
    }

    /// A GPU-only texture: the copy of the desktop a rendition scales from.
    pub fn texture(&self, w: u32, h: u32, format: DXGI_FORMAT, bind: D3D11_BIND_FLAG) -> Result<ID3D11Texture2D> {
        let desc = D3D11_TEXTURE2D_DESC {
            Width: w,
            Height: h,
            MipLevels: 1,
            ArraySize: 1,
            Format: format,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: bind.0 as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let mut t = None;
        unsafe { self.device.CreateTexture2D(&desc, None, Some(&mut t))? };
        Ok(t.expect("CreateTexture2D succeeded without a texture"))
    }

    /// Read a BGRA texture back to memory. Only the probe does this — it is how
    /// the exclusion test looks at the pixels — and nothing per-frame may.
    pub fn read_bgra(&self, src: &ID3D11Texture2D) -> Result<(u32, u32, Vec<u8>)> {
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        unsafe { src.GetDesc(&mut desc) };
        let staging_desc = D3D11_TEXTURE2D_DESC {
            Usage: D3D11_USAGE_STAGING,
            BindFlags: 0,
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
            MiscFlags: 0,
            ..desc
        };
        let mut staging = None;
        unsafe { self.device.CreateTexture2D(&staging_desc, None, Some(&mut staging))? };
        let staging = staging.expect("staging texture");
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        unsafe {
            self.context.CopyResource(&staging, src);
            self.context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
        }
        let row = desc.Width as usize * 4;
        let mut out = vec![0u8; row * desc.Height as usize];
        for y in 0..desc.Height as usize {
            // SAFETY: Map succeeded, so pData spans RowPitch * Height bytes.
            let src = unsafe { std::slice::from_raw_parts((mapped.pData as *const u8).add(y * mapped.RowPitch as usize), row) };
            out[y * row..(y + 1) * row].copy_from_slice(src);
        }
        unsafe { self.context.Unmap(&staging, 0) };
        Ok((desc.Width, desc.Height, out))
    }
}

/// `D3D11_VIDEO_PROCESSOR_COLOR_SPACE` is a bitfield: Usage:1, RGB_Range:1,
/// YCbCr_Matrix:1, YCbCr_xvYCC:1, Nominal_Range:2. The desktop is full-range
/// RGB; what leaves is BT.709 limited range, which is what the encoder's VUI
/// says (`encode.rs`) and what a browser decoder assumes for HD anyway.
const RGB_FULL: u32 = 0;
const YUV_709_LIMITED: u32 = (1 << 2) | (1 << 4);

/// BGRA at one size in, NV12 at another out, on the GPU's fixed-function
/// video engine rather than a shader: it is the same block the encoder sits
/// beside, and costs the 3D engine nothing a game might want.
pub struct Scaler {
    enumerator: ID3D11VideoProcessorEnumerator,
    processor: ID3D11VideoProcessor,
    pub src: (u32, u32),
    pub dst: (u32, u32),
    input: Option<(usize, ID3D11Texture2D, ID3D11VideoProcessorInputView)>,
    /// Output views by texture, which the encoder's sample pool recycles: a
    /// handful of textures, each seen many times. The texture is held so its
    /// address cannot be reused by another while the view is cached.
    outputs: Vec<(usize, u32, ID3D11Texture2D, ID3D11VideoProcessorOutputView)>,
}

unsafe impl Send for Scaler {}

impl Scaler {
    pub fn new(gpu: &Gpu, src: (u32, u32), dst: (u32, u32), fps: u32) -> Result<Scaler> {
        let rate = DXGI_RATIONAL { Numerator: fps.max(1), Denominator: 1 };
        let desc = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
            InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            InputFrameRate: rate,
            InputWidth: src.0,
            InputHeight: src.1,
            OutputFrameRate: rate,
            OutputWidth: dst.0,
            OutputHeight: dst.1,
            Usage: D3D11_VIDEO_USAGE_OPTIMAL_SPEED,
        };
        let enumerator = unsafe { gpu.video.CreateVideoProcessorEnumerator(&desc)? };
        let processor = unsafe { gpu.video.CreateVideoProcessor(&enumerator, 0)? };
        let vc = &gpu.video_context;
        unsafe {
            let src_rect = RECT { left: 0, top: 0, right: src.0 as i32, bottom: src.1 as i32 };
            let dst_rect = RECT { left: 0, top: 0, right: dst.0 as i32, bottom: dst.1 as i32 };
            vc.VideoProcessorSetStreamFrameFormat(&processor, 0, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE);
            vc.VideoProcessorSetStreamSourceRect(&processor, 0, true, Some(&src_rect));
            vc.VideoProcessorSetStreamDestRect(&processor, 0, true, Some(&dst_rect));
            vc.VideoProcessorSetOutputTargetRect(&processor, true, Some(&dst_rect));
            /* Drivers may "enhance" a stream by default (denoise, edge
               sharpening) — on text that is smearing. */
            vc.VideoProcessorSetStreamAutoProcessingMode(&processor, 0, false);
            vc.VideoProcessorSetStreamColorSpace(&processor, 0, &D3D11_VIDEO_PROCESSOR_COLOR_SPACE { _bitfield: RGB_FULL });
            vc.VideoProcessorSetOutputColorSpace(&processor, &D3D11_VIDEO_PROCESSOR_COLOR_SPACE { _bitfield: YUV_709_LIMITED });
        }
        Ok(Scaler { enumerator, processor, src, dst, input: None, outputs: Vec::new() })
    }

    /// Convert `src` (the whole desktop copy) into subresource `index` of `dst`.
    pub fn blt(&mut self, gpu: &Gpu, src: &ID3D11Texture2D, dst: &ID3D11Texture2D, index: u32) -> Result<()> {
        let src_key = src.as_raw() as usize;
        if self.input.as_ref().map(|i| i.0) != Some(src_key) {
            let desc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
                FourCC: 0,
                ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 {
                    Texture2D: D3D11_TEX2D_VPIV { MipSlice: 0, ArraySlice: 0 },
                },
            };
            let mut view = None;
            unsafe { gpu.video.CreateVideoProcessorInputView(src, &self.enumerator, &desc, Some(&mut view))? };
            self.input = Some((src_key, src.clone(), view.expect("input view")));
        }
        let dst_key = dst.as_raw() as usize;
        let out = match self.outputs.iter().position(|o| o.0 == dst_key && o.1 == index) {
            Some(i) => self.outputs[i].3.clone(),
            None => {
                let mut tdesc = D3D11_TEXTURE2D_DESC::default();
                unsafe { dst.GetDesc(&mut tdesc) };
                let desc = if tdesc.ArraySize > 1 {
                    D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                        ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2DARRAY,
                        Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 {
                            Texture2DArray: D3D11_TEX2D_ARRAY_VPOV { MipSlice: 0, FirstArraySlice: index, ArraySize: 1 },
                        },
                    }
                } else {
                    D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                        ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
                        Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 } },
                    }
                };
                let mut view = None;
                unsafe { gpu.video.CreateVideoProcessorOutputView(dst, &self.enumerator, &desc, Some(&mut view))? };
                let view = view.expect("output view");
                if self.outputs.len() >= 16 {
                    self.outputs.remove(0);
                }
                self.outputs.push((dst_key, index, dst.clone(), view.clone()));
                view
            }
        };
        let input = self.input.as_ref().map(|i| i.2.clone());
        let stream = D3D11_VIDEO_PROCESSOR_STREAM {
            Enable: true.into(),
            pInputSurface: std::mem::ManuallyDrop::new(input),
            ..Default::default()
        };
        let streams = [stream];
        let result = unsafe { gpu.video_context.VideoProcessorBlt(&self.processor, &out, 0, &streams) };
        /* Submit now. The blt otherwise sits in the immediate context's
           command buffer until something else flushes it, and the encoder —
           on its own context — waits on the texture for exactly that long. */
        unsafe { gpu.context.Flush() };
        // The stream holds a counted reference the struct will not release.
        let [mut stream] = streams;
        unsafe { std::mem::ManuallyDrop::drop(&mut stream.pInputSurface) };
        result
    }
}

/// A frame carried from the adapter that captured it to another one, through
/// system memory: Desktop Duplication only works on the adapter that drives
/// the output, and on a hybrid laptop that may not be the one with the idle
/// encoder. D3D11 cannot share a texture across adapters, so this is a map on
/// one side and an upload on the other — measured in the Probe section of
/// `docs/SCREENS.md` before anything relies on it.
pub struct Bridge {
    staging: ID3D11Texture2D,
    pub dst: ID3D11Texture2D,
    size: (u32, u32),
}

unsafe impl Send for Bridge {}

impl Bridge {
    pub fn new(from: &Gpu, to: &Gpu, size: (u32, u32)) -> Result<Bridge> {
        let desc = D3D11_TEXTURE2D_DESC {
            Width: size.0,
            Height: size.1,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_STAGING,
            BindFlags: 0,
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
            MiscFlags: 0,
        };
        let mut staging = None;
        unsafe { from.device.CreateTexture2D(&desc, None, Some(&mut staging))? };
        let dst = to.texture(size.0, size.1, DXGI_FORMAT_B8G8R8A8_UNORM, D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE)?;
        Ok(Bridge { staging: staging.expect("staging"), dst, size })
    }

    pub fn carry(&self, from: &Gpu, to: &Gpu, src: &ID3D11Texture2D) -> Result<()> {
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        unsafe {
            from.context.CopyResource(&self.staging, src);
            from.context.Map(&self.staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
            to.context.UpdateSubresource(&self.dst, 0, None, mapped.pData, mapped.RowPitch, mapped.RowPitch * self.size.1);
            from.context.Unmap(&self.staging, 0);
        }
        Ok(())
    }
}
