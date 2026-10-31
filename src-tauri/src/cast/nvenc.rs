//! H.264 on an NVIDIA GPU through NVENC's own API, for when Media Foundation
//! cannot reach it.
//!
//! On the hybrid laptop NVIDIA's H.264 MFT is listed for the RTX 4080 but
//! `ActivateObject` fails with `E_UNEXPECTED` in this process, filtered or
//! not, while ffmpeg's `h264_nvenc` — which calls `nvEncodeAPI64.dll`
//! directly — encodes 1440p there without complaint. So the hardware is fine
//! and the MFT wrapper is what refuses. This talks to the DLL the driver ships,
//! loaded at run time: no SDK install, no C build, and a machine without an
//! NVIDIA driver simply has no NVENC.
//!
//! **The layouts are not guessed.** Every offset below was printed by MSVC from
//! FFmpeg's MIT-licensed `nv-codec-headers` at tag `n12.1.14.0` (`nvEncodeAPI.h`,
//! API 12.1), with a ten-line C program `offsetof`-ing each field this file
//! touches. Structs are zeroed byte buffers at least as large as the header's
//! `sizeof`, written at those offsets: the driver checks the version word, not
//! the size, and a buffer that is larger than the struct costs nothing. Only
//! the fields set here are set; the rest are the zeros the header requires.
//!
//! The frame arrives as BGRA. At native size NVENC takes it as `ARGB` and
//! converts the colour itself, off the iGPU whose 3D engine the probe found
//! pegged; at any other size the NVIDIA device's own video processor scales
//! it to NV12 first, since NVENC does not scale.
//!
//! **Carrying across adapters is split in two**, because the first cut did it
//! all on the capture thread and measured 6 ms of it there — 39 fps where the
//! MFT made 50. Now the capture thread only queues a GPU copy into a staging
//! texture on its own adapter (microseconds, asynchronous), and the encode
//! thread maps it — which waits for that copy — and uploads it to the NVIDIA
//! device. D3D11 cannot share a texture between two adapters, so system
//! memory in the middle is the price; this just pays it off the capture path.
//!
//! Synchronous mode on a thread of its own: `EncodePicture` then
//! `LockBitstream`, which waits for the hardware. A ring of three input
//! textures (and staging textures, across adapters) lets the capture thread
//! fill one while the encoder reads another, and as with the MFT exactly one
//! frame may be pending — a newer one replaces it.

use super::encode::{Encoded, Settings};
use super::gpu::{Gpu, Scaler};
use std::ffi::c_void;
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::Instant;
use windows::core::{Interface, GUID, PCSTR};
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Texture2D, D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_CPU_ACCESS_READ, D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_READ,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::Common::DXGI_SAMPLE_DESC;
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_NV12};
use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};

// ---- the ABI, from nvEncodeAPI.h 12.1 (offsets printed by MSVC) -------------

const API_VERSION: u32 = 0x0100_000c; // 12 | 1 << 24
const FUNCTION_LIST_VER: u32 = 0x7102_000c;
const OPEN_VER: u32 = 0x7101_000c;
const PRESET_VER: u32 = 0xf104_000c;
const CONFIG_VER: u32 = 0xf108_000c;
const INIT_VER: u32 = 0xf106_000c;
const RECONF_VER: u32 = 0xf101_000c;
const BITSTREAM_VER: u32 = 0x7101_000c;
const REGISTER_VER: u32 = 0x7104_000c;
const MAP_VER: u32 = 0x7104_000c;
const PIC_VER: u32 = 0xf106_000c;
const LOCK_VER: u32 = 0xf101_000c;

const SIZE_FUNCTION_LIST: usize = 2552;
const SIZE_OPEN: usize = 1552;
const SIZE_PRESET: usize = 5128;
const SIZE_CONFIG: usize = 3584;
const SIZE_INIT: usize = 1808;
const SIZE_RECONF: usize = 1824;
const SIZE_BITSTREAM: usize = 776;
const SIZE_REGISTER: usize = 1536;
const SIZE_MAP: usize = 1544;
const SIZE_PIC: usize = 3360;
const SIZE_LOCK: usize = 1552;

// NV_ENCODE_API_FUNCTION_LIST
const FN_INITIALIZE: usize = 96;
const FN_CREATE_BITSTREAM: usize = 120;
const FN_DESTROY_BITSTREAM: usize = 128;
const FN_ENCODE: usize = 136;
const FN_LOCK: usize = 144;
const FN_UNLOCK: usize = 152;
const FN_MAP: usize = 208;
const FN_UNMAP: usize = 216;
const FN_DESTROY: usize = 224;
const FN_OPEN_EX: usize = 240;
const FN_REGISTER: usize = 248;
const FN_UNREGISTER: usize = 256;
const FN_RECONFIGURE: usize = 264;
const FN_LAST_ERROR: usize = 304;
const FN_PRESET_EX: usize = 320;

// NV_ENC_CONFIG
const CFG_GOP: usize = 20;
const CFG_FRAME_INTERVAL_P: usize = 24;
const CFG_RC_MODE: usize = 44;
const CFG_AVG_BITRATE: usize = 60;
const CFG_MAX_BITRATE: usize = 64;
const CFG_VBV_SIZE: usize = 68;
const CFG_VBV_DELAY: usize = 72;
const CFG_H264_IDR_PERIOD: usize = 176;
const CFG_VUI_SIGNAL_PRESENT: usize = 248;
const CFG_VUI_FORMAT: usize = 252;
const CFG_VUI_FULL_RANGE: usize = 256;
const CFG_VUI_COLOUR_PRESENT: usize = 260;
const CFG_VUI_PRIMARIES: usize = 264;
const CFG_VUI_TRANSFER: usize = 268;
const CFG_VUI_MATRIX: usize = 272;

const INFINITE_GOP: u32 = 0xffff_ffff;
const RC_CBR: u32 = 2;
const TUNING_ULTRA_LOW_LATENCY: u32 = 3;
const VUI_BT709: u32 = 1;
const VUI_FORMAT_UNSPECIFIED: u32 = 5;
const FMT_NV12: u32 = 0x0000_0001;
const FMT_ARGB: u32 = 0x0100_0000;
const PIC_FLAG_FORCEIDR: u32 = 0x2;
const PIC_FLAG_OUTPUT_SPSPPS: u32 = 0x4;
const PIC_STRUCT_FRAME: u32 = 1;
const PIC_TYPE_I: u32 = 2;
const PIC_TYPE_IDR: u32 = 3;

const CODEC_H264: GUID = GUID::from_values(0x6bc82762, 0x4e63, 0x4ca4, [0xaa, 0x85, 0x1e, 0x50, 0xf3, 0x21, 0xf6, 0xbf]);
/// P1 is the fastest preset; with ultra-low-latency tuning it is what
/// streaming uses (no B-frames, no lookahead).
const PRESET_P1: GUID = GUID::from_values(0xfc0a8d3e, 0x45f8, 0x4cf8, [0x80, 0xc7, 0x29, 0x88, 0x71, 0x59, 0x0e, 0xbf]);

type Status = u32;
type CreateInstance = unsafe extern "system" fn(*mut u8) -> Status;
type MaxVersion = unsafe extern "system" fn(*mut u32) -> Status;
type OpenEx = unsafe extern "system" fn(*mut u8, *mut *mut c_void) -> Status;
type PresetEx = unsafe extern "system" fn(*mut c_void, GUID, GUID, u32, *mut u8) -> Status;
type WithParams = unsafe extern "system" fn(*mut c_void, *mut u8) -> Status;
type WithPtr = unsafe extern "system" fn(*mut c_void, *mut c_void) -> Status;
type LastError = unsafe extern "system" fn(*mut c_void) -> *const i8;

/// A zeroed, 8-aligned struct buffer with its version word written.
struct Buf(Vec<u64>);

impl Buf {
    fn new(size: usize, version: u32) -> Buf {
        let mut b = Buf(vec![0u64; size.div_ceil(8) + 8]);
        b.put_u32(0, version);
        b
    }
    fn ptr(&mut self) -> *mut u8 {
        self.0.as_mut_ptr() as *mut u8
    }
    fn bytes(&mut self) -> &mut [u8] {
        let len = self.0.len() * 8;
        unsafe { std::slice::from_raw_parts_mut(self.ptr(), len) }
    }
    fn put_u32(&mut self, at: usize, v: u32) {
        self.bytes()[at..at + 4].copy_from_slice(&v.to_le_bytes());
    }
    fn put_u64(&mut self, at: usize, v: u64) {
        self.bytes()[at..at + 8].copy_from_slice(&v.to_le_bytes());
    }
    fn put_ptr(&mut self, at: usize, p: *const c_void) {
        self.put_u64(at, p as usize as u64);
    }
    fn put_guid(&mut self, at: usize, g: &GUID) {
        let b = self.bytes();
        b[at..at + 4].copy_from_slice(&g.data1.to_le_bytes());
        b[at + 4..at + 6].copy_from_slice(&g.data2.to_le_bytes());
        b[at + 6..at + 8].copy_from_slice(&g.data3.to_le_bytes());
        b[at + 8..at + 16].copy_from_slice(&g.data4);
    }
    fn u32_at(&mut self, at: usize) -> u32 {
        u32::from_le_bytes(self.bytes()[at..at + 4].try_into().unwrap())
    }
    fn u64_at(&mut self, at: usize) -> u64 {
        u64::from_le_bytes(self.bytes()[at..at + 8].try_into().unwrap())
    }
    fn ptr_at(&mut self, at: usize) -> *mut c_void {
        self.u64_at(at) as usize as *mut c_void
    }
}

/// The DLL's function table.
struct Api {
    list: Buf,
}

// SAFETY: a table of function pointers into a DLL that is never unloaded.
unsafe impl Send for Api {}
unsafe impl Sync for Api {}

impl Api {
    fn f<T: Copy>(&self, at: usize) -> Option<T> {
        let p = u64::from_le_bytes(unsafe { std::slice::from_raw_parts((self.list.0.as_ptr() as *const u8).add(at), 8) }.try_into().ok()?);
        (p != 0).then(|| unsafe { std::mem::transmute_copy::<u64, T>(&p) })
    }
}

fn api() -> Result<&'static Api, String> {
    static API: std::sync::OnceLock<Result<Api, String>> = std::sync::OnceLock::new();
    API.get_or_init(|| unsafe {
        let lib: HMODULE = LoadLibraryW(windows::core::w!("nvEncodeAPI64.dll")).map_err(|_| "no NVIDIA driver (nvEncodeAPI64.dll)".to_string())?;
        let max = GetProcAddress(lib, PCSTR(b"NvEncodeAPIGetMaxSupportedVersion\0".as_ptr())).ok_or("nvEncodeAPI64.dll has no version query")?;
        let max: MaxVersion = std::mem::transmute(max);
        let mut v = 0u32;
        max(&mut v);
        // The driver answers major << 4 | minor; this file speaks 12.1.
        if v < (12 << 4 | 1) {
            return Err(format!("the NVIDIA driver speaks NVENC {}.{}; 12.1 is needed", v >> 4, v & 0xf));
        }
        let create = GetProcAddress(lib, PCSTR(b"NvEncodeAPICreateInstance\0".as_ptr())).ok_or("nvEncodeAPI64.dll has no entry point")?;
        let create: CreateInstance = std::mem::transmute(create);
        let mut list = Buf::new(SIZE_FUNCTION_LIST, FUNCTION_LIST_VER);
        check(create(list.ptr()), "creating the API instance", None)?;
        Ok(Api { list })
    })
    .as_ref()
    .map_err(|e| e.clone())
}

fn check(s: Status, what: &str, last: Option<(&Api, *mut c_void)>) -> Result<(), String> {
    if s == 0 {
        return Ok(());
    }
    let detail = last
        .and_then(|(a, enc)| a.f::<LastError>(FN_LAST_ERROR).map(|f| unsafe { f(enc) }))
        .filter(|p| !p.is_null())
        .map(|p| unsafe { std::ffi::CStr::from_ptr(p) }.to_string_lossy().into_owned())
        .unwrap_or_default();
    Err(format!("NVENC {what}: status {s}{}", if detail.is_empty() { String::new() } else { format!(" ({detail})") }))
}

/// Whether NVENC is here at all: the DLL loads and speaks 12.1.
pub fn available() -> Result<(), String> {
    api().map(|_| ())
}

// ---- the encoder --------------------------------------------------------------

struct Job {
    idx: usize,
    time: i64,
    key: bool,
}

#[derive(Default)]
struct State {
    pending: Option<Job>,
    busy: Option<usize>,
    stop: bool,
    kbps: Option<u32>,
}

struct Session {
    enc: *mut c_void,
    regs: Vec<*mut c_void>,
    bitstream: *mut c_void,
    init: Mutex<Buf>,
    config: Mutex<Buf>,
    fmt: u32,
    size: (u32, u32),
    fps: u32,
    state: Mutex<State>,
    wake: Condvar,
    /// The adapter that captured, and the NVIDIA one encoding — the same
    /// device when NVIDIA drives the output.
    from: Arc<Gpu>,
    to: Arc<Gpu>,
    src: (u32, u32),
    /// NVENC's registered inputs, on `to`.
    inputs: Vec<ID3D11Texture2D>,
    /// Across adapters only: CPU-readable copies on `from`, one per input.
    staging: Vec<ID3D11Texture2D>,
    /// Across adapters and scaling: the uploaded BGRA the scaler reads.
    mid: Option<ID3D11Texture2D>,
    scaler: Mutex<Option<Scaler>>,
}

// SAFETY: NVENC handles are usable from any thread; every call that touches
// the session after setup is made by the encode thread, except the
// unregistering in `Drop`, which runs after that thread has been joined.
unsafe impl Send for Session {}
unsafe impl Sync for Session {}

/// An NVENC session for one rendition, fed from the capturing adapter.
pub struct Nvenc {
    session: Arc<Session>,
    thread: Option<JoinHandle<()>>,
    pub name: String,
    pub settings: Settings,
}

unsafe impl Send for Nvenc {}

fn config_for(api: &Api, enc: *mut c_void, s: &Settings) -> Result<Buf, String> {
    let preset: PresetEx = api.f(FN_PRESET_EX).ok_or("no preset query")?;
    let mut p = Buf::new(SIZE_PRESET, PRESET_VER);
    p.put_u32(8, CONFIG_VER);
    check(unsafe { preset(enc, CODEC_H264, PRESET_P1, TUNING_ULTRA_LOW_LATENCY, p.ptr()) }, "reading the P1 preset", Some((api, enc)))?;
    let mut c = Buf::new(SIZE_CONFIG, CONFIG_VER);
    let from = p.bytes()[8..8 + SIZE_CONFIG].to_vec();
    c.bytes()[..SIZE_CONFIG].copy_from_slice(&from);
    c.put_u32(0, CONFIG_VER);
    // An infinite GOP and IDRs on demand, as with the MFT; P frames only.
    c.put_u32(CFG_GOP, INFINITE_GOP);
    c.put_u32(CFG_FRAME_INTERVAL_P, 1);
    c.put_u32(CFG_H264_IDR_PERIOD, INFINITE_GOP);
    set_rate(&mut c, s.kbps, s.fps);
    /* BT.709, limited range, said in the VUI. With ARGB input NVENC converts
       by the matrix the VUI names, so this is also what makes the colours
       right — checked by decoding a known-green window (SCREENS.md, Probe). */
    c.put_u32(CFG_VUI_SIGNAL_PRESENT, 1);
    c.put_u32(CFG_VUI_FORMAT, VUI_FORMAT_UNSPECIFIED);
    c.put_u32(CFG_VUI_FULL_RANGE, 0);
    c.put_u32(CFG_VUI_COLOUR_PRESENT, 1);
    c.put_u32(CFG_VUI_PRIMARIES, VUI_BT709);
    c.put_u32(CFG_VUI_TRANSFER, VUI_BT709);
    c.put_u32(CFG_VUI_MATRIX, VUI_BT709);
    Ok(c)
}

/// CBR with a one-frame VBV: the low-latency shape — no frame may borrow
/// bits from the next, because the next is the one the viewer is waiting for.
fn set_rate(c: &mut Buf, kbps: u32, fps: u32) {
    let bps = kbps.saturating_mul(1000);
    c.put_u32(CFG_RC_MODE, RC_CBR);
    c.put_u32(CFG_AVG_BITRATE, bps);
    c.put_u32(CFG_MAX_BITRATE, bps);
    c.put_u32(CFG_VBV_SIZE, bps / fps.max(1));
    c.put_u32(CFG_VBV_DELAY, bps / fps.max(1));
}

impl Nvenc {
    /// An NVENC session on `gpu` (an NVIDIA adapter) encoding frames that
    /// arrive as BGRA of size `src` on `from` — the capturing adapter, which
    /// may be `gpu` itself.
    pub fn new(from: Arc<Gpu>, gpu: Arc<Gpu>, src: (u32, u32), settings: Settings, mut on_output: Box<dyn FnMut(Encoded) + Send>) -> Result<Nvenc, String> {
        let api = api()?;
        let open: OpenEx = api.f(FN_OPEN_EX).ok_or("no open")?;
        let mut o = Buf::new(SIZE_OPEN, OPEN_VER);
        o.put_u32(4, 0); // NV_ENC_DEVICE_TYPE_DIRECTX
        o.put_ptr(8, gpu.device.as_raw());
        o.put_u32(24, API_VERSION);
        let mut enc: *mut c_void = std::ptr::null_mut();
        check(unsafe { open(o.ptr(), &mut enc) }, "opening a session", None)?;

        let native = (settings.w, settings.h) == src;
        let fmt = if native { FMT_ARGB } else { FMT_NV12 };
        let fail = |e: String| {
            if let Some(d) = api.f::<WithParams>(FN_DESTROY) {
                unsafe { (std::mem::transmute::<WithParams, unsafe extern "system" fn(*mut c_void) -> Status>(d))(enc) };
            }
            e
        };
        let mut config = config_for(api, enc, &settings).map_err(fail)?;
        let mut init = Buf::new(SIZE_INIT, INIT_VER);
        init.put_guid(4, &CODEC_H264);
        init.put_guid(20, &PRESET_P1);
        init.put_u32(36, settings.w);
        init.put_u32(40, settings.h);
        init.put_u32(44, settings.w);
        init.put_u32(48, settings.h);
        init.put_u32(52, settings.fps.max(1));
        init.put_u32(56, 1);
        init.put_u32(60, 0); // synchronous
        init.put_u32(64, 1); // the encoder decides picture types
        init.put_ptr(88, config.ptr() as *const c_void);
        init.put_u32(96, settings.w);
        init.put_u32(100, settings.h);
        init.put_u32(136, TUNING_ULTRA_LOW_LATENCY);
        let initialize: WithParams = api.f(FN_INITIALIZE).ok_or("no initialize").map_err(|e| fail(e.into()))?;
        check(unsafe { initialize(enc, init.ptr()) }, "initializing the encoder", Some((api, enc))).map_err(fail)?;

        let mut bs = Buf::new(SIZE_BITSTREAM, BITSTREAM_VER);
        let create_bs: WithParams = api.f(FN_CREATE_BITSTREAM).ok_or("no bitstream").map_err(|e| fail(e.into()))?;
        check(unsafe { create_bs(enc, bs.ptr()) }, "making a bitstream buffer", Some((api, enc))).map_err(fail)?;
        let bitstream = bs.ptr_at(16);

        let (dx_fmt, bind) = if native {
            (DXGI_FORMAT_B8G8R8A8_UNORM, D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE)
        } else {
            (DXGI_FORMAT_NV12, D3D11_BIND_RENDER_TARGET)
        };
        let register: WithParams = api.f(FN_REGISTER).ok_or("no register").map_err(|e| fail(e.into()))?;
        let mut inputs = Vec::new();
        let mut regs = Vec::new();
        for _ in 0..3 {
            let t = gpu.texture(settings.w, settings.h, dx_fmt, bind).map_err(|e| fail(format!("an input texture: {e}")))?;
            let mut r = Buf::new(SIZE_REGISTER, REGISTER_VER);
            r.put_u32(4, 0); // NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX
            r.put_u32(8, settings.w);
            r.put_u32(12, settings.h);
            r.put_ptr(24, t.as_raw());
            r.put_u32(40, fmt);
            r.put_u32(44, 0); // NV_ENC_INPUT_IMAGE
            check(unsafe { register(enc, r.ptr()) }, "registering an input", Some((api, enc))).map_err(fail)?;
            regs.push(r.ptr_at(32));
            inputs.push(t);
        }
        let across = from.luid != gpu.luid;
        let mut staging = Vec::new();
        if across {
            for _ in 0..inputs.len() {
                staging.push(stage(&from, src).map_err(|e| fail(format!("a staging texture: {e}")))?);
            }
        }
        let mid = if across && !native {
            Some(gpu.texture(src.0, src.1, DXGI_FORMAT_B8G8R8A8_UNORM, D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE).map_err(|e| fail(format!("a texture: {e}")))?)
        } else {
            None
        };
        let scaler = if native { None } else { Some(Scaler::new(&gpu, src, (settings.w, settings.h), settings.fps).map_err(|e| fail(format!("the scaler: {e}")))?) };

        let session = Arc::new(Session {
            enc,
            regs,
            bitstream,
            init: Mutex::new(init),
            config: Mutex::new(config),
            fmt,
            size: (settings.w, settings.h),
            fps: settings.fps,
            state: Mutex::default(),
            wake: Condvar::new(),
            from,
            to: gpu,
            src,
            inputs,
            staging,
            mid,
            scaler: Mutex::new(scaler),
        });
        let s = session.clone();
        let thread = std::thread::Builder::new()
            .name("cast-nvenc".into())
            .spawn(move || {
                crate::cast::capture::urgent();
                run(api, &s, &mut on_output);
            })
            .map_err(|e| e.to_string())?;
        let name = if across { "NVIDIA NVENC (nvEncodeAPI), across adapters" } else { "NVIDIA NVENC (nvEncodeAPI)" };
        Ok(Nvenc { session, thread: Some(thread), name: name.into(), settings })
    }

    /// Hand a frame over: `src` is the BGRA desktop on the capturing adapter.
    /// Across adapters this only queues a GPU copy; the rest happens on the
    /// encode thread.
    pub fn submit(&mut self, src: &ID3D11Texture2D, time: i64, key: bool) -> Result<(), String> {
        let s = &self.session;
        let idx = {
            let st = s.state.lock().unwrap();
            (0..s.inputs.len()).find(|i| Some(*i) != st.busy && st.pending.as_ref().map(|p| p.idx) != Some(*i)).unwrap_or(0)
        };
        if !s.staging.is_empty() {
            unsafe {
                s.from.context.CopyResource(&s.staging[idx], src);
                s.from.context.Flush();
            }
        } else {
            match s.scaler.lock().unwrap().as_mut() {
                Some(sc) => sc.blt(&s.to, src, &s.inputs[idx], 0).map_err(|e| format!("scaling: {e}"))?,
                None => unsafe { s.to.context.CopyResource(&s.inputs[idx], src) },
            }
            unsafe { s.to.context.Flush() };
        }
        let mut st = s.state.lock().unwrap();
        let key = key || st.pending.as_ref().is_some_and(|p| p.key);
        st.pending = Some(Job { idx, time, key });
        drop(st);
        s.wake.notify_one();
        Ok(())
    }

    /// Taken with the next frame encoded.
    pub fn set_kbps(&mut self, kbps: u32) {
        self.settings.kbps = kbps;
        self.session.state.lock().unwrap().kbps = Some(kbps);
    }
}

impl Drop for Nvenc {
    fn drop(&mut self) {
        self.session.state.lock().unwrap().stop = true;
        self.session.wake.notify_all();
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
        let Ok(api) = api() else { return };
        let s = &self.session;
        unsafe {
            if let Some(unregister) = api.f::<WithPtr>(FN_UNREGISTER) {
                for r in &s.regs {
                    unregister(s.enc, *r);
                }
            }
            if let Some(destroy_bs) = api.f::<WithPtr>(FN_DESTROY_BITSTREAM) {
                destroy_bs(s.enc, s.bitstream);
            }
            if let Some(d) = api.f::<WithParams>(FN_DESTROY) {
                (std::mem::transmute::<WithParams, unsafe extern "system" fn(*mut c_void) -> Status>(d))(s.enc);
            }
        }
    }
}

fn stage(from: &Gpu, size: (u32, u32)) -> windows::core::Result<ID3D11Texture2D> {
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
    let mut t = None;
    unsafe { from.device.CreateTexture2D(&desc, None, Some(&mut t))? };
    Ok(t.expect("staging texture"))
}

/// The second half of a carry, on the encode thread: map the staging copy
/// (which waits for it), upload it to the NVIDIA device, and scale it there
/// if this rendition is not native size.
fn carry(s: &Session, idx: usize) -> Result<(), String> {
    let staging = &s.staging[idx];
    let target = s.mid.as_ref().unwrap_or(&s.inputs[idx]);
    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
    unsafe {
        s.from.context.Map(staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)).map_err(|e| format!("reading the frame back: {e}"))?;
        s.to.context.UpdateSubresource(target, 0, None, mapped.pData, mapped.RowPitch, mapped.RowPitch * s.src.1);
        s.from.context.Unmap(staging, 0);
    }
    if let (Some(mid), Some(sc)) = (&s.mid, s.scaler.lock().unwrap().as_mut()) {
        sc.blt(&s.to, mid, &s.inputs[idx], 0).map_err(|e| format!("scaling: {e}"))?;
    }
    unsafe { s.to.context.Flush() };
    Ok(())
}

fn run(api: &Api, s: &Session, on_output: &mut Box<dyn FnMut(Encoded) + Send>) {
    let (Some(map), Some(unmap), Some(encode), Some(lock), Some(unlock), Some(reconf)) = (
        api.f::<WithParams>(FN_MAP),
        api.f::<WithPtr>(FN_UNMAP),
        api.f::<WithParams>(FN_ENCODE),
        api.f::<WithParams>(FN_LOCK),
        api.f::<WithPtr>(FN_UNLOCK),
        api.f::<WithParams>(FN_RECONFIGURE),
    ) else {
        return;
    };
    loop {
        let (job, kbps) = {
            let mut st = s.state.lock().unwrap();
            while st.pending.is_none() && !st.stop {
                st = s.wake.wait(st).unwrap();
            }
            if st.stop {
                return;
            }
            let job = st.pending.take().unwrap();
            st.busy = Some(job.idx);
            (job, st.kbps.take())
        };
        if let Some(k) = kbps {
            let mut c = s.config.lock().unwrap();
            set_rate(&mut c, k, s.fps);
            let mut init = s.init.lock().unwrap();
            init.put_ptr(88, c.ptr() as *const c_void);
            let mut r = Buf::new(SIZE_RECONF, RECONF_VER);
            let bytes = init.bytes()[..SIZE_INIT].to_vec();
            r.bytes()[8..8 + SIZE_INIT].copy_from_slice(&bytes);
            if let Err(e) = check(unsafe { reconf(s.enc, r.ptr()) }, "changing the bitrate", Some((api, s.enc))) {
                log::warn!("cast: {e}");
            }
        }
        let started = Instant::now();
        let out = (|| -> Result<Encoded, String> {
            if !s.staging.is_empty() {
                carry(s, job.idx)?;
            }
            let mut m = Buf::new(SIZE_MAP, MAP_VER);
            m.put_ptr(16, s.regs[job.idx]);
            check(unsafe { map(s.enc, m.ptr()) }, "mapping the input", Some((api, s.enc)))?;
            let mapped = m.ptr_at(24);
            let mapped_fmt = m.u32_at(32);
            let mut p = Buf::new(SIZE_PIC, PIC_VER);
            p.put_u32(4, s.size.0);
            p.put_u32(8, s.size.1);
            p.put_u32(16, if job.key { PIC_FLAG_FORCEIDR | PIC_FLAG_OUTPUT_SPSPPS } else { 0 });
            p.put_u64(24, job.time as u64);
            p.put_u64(32, 10_000_000 / s.fps.max(1) as u64);
            p.put_ptr(40, mapped);
            p.put_ptr(48, s.bitstream);
            p.put_u32(64, if mapped_fmt != 0 { mapped_fmt } else { s.fmt });
            p.put_u32(68, PIC_STRUCT_FRAME);
            let r = check(unsafe { encode(s.enc, p.ptr()) }, "encoding", Some((api, s.enc)));
            let result = r.and_then(|_| {
                let mut l = Buf::new(SIZE_LOCK, LOCK_VER);
                l.put_ptr(8, s.bitstream);
                check(unsafe { lock(s.enc, l.ptr()) }, "locking the bitstream", Some((api, s.enc)))?;
                let len = l.u32_at(36) as usize;
                let data = l.ptr_at(56) as *const u8;
                let annex_b = unsafe { std::slice::from_raw_parts(data, len) }.to_vec();
                let pic = l.u32_at(64);
                let time = l.u64_at(40) as i64;
                unsafe { unlock(s.enc, s.bitstream) };
                let at = Instant::now();
                let key = pic == PIC_TYPE_IDR || pic == PIC_TYPE_I || super::encode::is_idr(&annex_b);
                Ok(Encoded { annex_b, key, time, at, held: Some(at.duration_since(started)) })
            });
            unsafe { unmap(s.enc, mapped) };
            result
        })();
        s.state.lock().unwrap().busy = None;
        match out {
            Ok(e) => on_output(e),
            Err(e) => log::warn!("cast: {e}"),
        }
    }
}
