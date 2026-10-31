//! H.264 on the GPU that owns the frame: Media Foundation's *hardware*
//! encoder MFT, fed NV12 textures through an `IMFDXGIDeviceManager` so a frame
//! goes capture → convert → encode without once reaching system memory.
//!
//! Hardware MFTs are asynchronous: the encoder says when it wants input
//! (`METransformNeedInput`) and when it has output (`METransformHaveOutput`)
//! on its own event queue. A thread per encoder blocks on that queue; the
//! capture thread feeds a frame the moment a credit exists, and otherwise
//! leaves it as the one pending frame — a newer capture replaces it, because a
//! remote desktop wants the latest frame, never a queue of old ones.
//!
//! Settings are the low-latency set: `CODECAPI_AVLowLatencyMode` (one frame
//! in, one out — no lookahead), no B-frames, CBR, and a GOP long enough to be
//! infinite in practice with keyframes forced when a viewer joins or loses its
//! place. The output is Annex-B; every IDR must carry SPS and PPS in-band,
//! because WebCodecs is configured with no `description` and a decoder that
//! joins mid-stream has nothing else to start from. `ParamSets` makes sure of
//! it whatever a particular vendor's encoder does.
//!
//! The H.264 helpers at the top are pure and tested; the MF half is Windows.

use std::borrow::Cow;

/// NAL units of an Annex-B buffer, start codes stripped: `(nal_type, unit)`.
pub fn nals(b: &[u8]) -> Vec<(u8, &[u8])> {
    let mut starts = Vec::new();
    let mut i = 0;
    while i + 3 <= b.len() {
        if b[i] == 0 && b[i + 1] == 0 && b[i + 2] == 1 {
            starts.push((i, i + 3));
            i += 3;
        } else {
            i += 1;
        }
    }
    let mut out = Vec::new();
    for (k, &(_, body)) in starts.iter().enumerate() {
        let mut end = starts.get(k + 1).map(|s| s.0).unwrap_or(b.len());
        // A four-byte start code leaves its leading zero on the unit before.
        while k + 1 < starts.len() && end > body && b[end - 1] == 0 {
            end -= 1;
        }
        if end > body {
            out.push((b[body] & 0x1f, &b[body..end]));
        }
    }
    out
}

pub const NAL_IDR: u8 = 5;
pub const NAL_SPS: u8 = 7;
pub const NAL_PPS: u8 = 8;

pub fn is_idr(annex_b: &[u8]) -> bool {
    nals(annex_b).iter().any(|n| n.0 == NAL_IDR)
}

/// WebCodecs' codec string, read off the SPS: `avc1.` then profile_idc,
/// the constraint flags and level_idc, two hex digits each.
pub fn codec_string(annex_b: &[u8]) -> Option<String> {
    let sps = nals(annex_b).into_iter().find(|n| n.0 == NAL_SPS)?.1;
    (sps.len() >= 4).then(|| format!("avc1.{:02x}{:02x}{:02x}", sps[1], sps[2], sps[3]))
}

/// The last SPS and PPS the encoder emitted, so an IDR that arrives without
/// them can be sent with them. Intel's and NVIDIA's MFTs both repeat them on
/// every IDR as measured (`docs/SCREENS.md`, "Probe"); this is for the one
/// that does not, since without them a joining decoder shows nothing at all.
#[derive(Default)]
pub struct ParamSets {
    sps: Option<Vec<u8>>,
    pps: Option<Vec<u8>>,
}

impl ParamSets {
    pub fn ensure<'a>(&mut self, annex_b: &'a [u8]) -> Cow<'a, [u8]> {
        let units = nals(annex_b);
        let mut has = (false, false, false);
        for (t, u) in &units {
            match *t {
                NAL_SPS => {
                    self.sps = Some(u.to_vec());
                    has.0 = true;
                }
                NAL_PPS => {
                    self.pps = Some(u.to_vec());
                    has.1 = true;
                }
                NAL_IDR => has.2 = true,
                _ => {}
            }
        }
        if !has.2 || (has.0 && has.1) {
            return Cow::Borrowed(annex_b);
        }
        let mut out = Vec::with_capacity(annex_b.len() + 64);
        for (present, unit) in [(has.0, &self.sps), (has.1, &self.pps)] {
            if let (false, Some(u)) = (present, unit) {
                out.extend_from_slice(&[0, 0, 0, 1]);
                out.extend_from_slice(u);
            }
        }
        out.extend_from_slice(annex_b);
        Cow::Owned(out)
    }
}

/// What a rendition asks of its encoder.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Settings {
    pub w: u32,
    pub h: u32,
    pub fps: u32,
    pub kbps: u32,
    /// Feed the desktop's own BGRA (`MFVideoFormat_ARGB32`) rather than NV12,
    /// leaving the colour conversion to the encoder: only at native size,
    /// since the encoder does not scale. Measured *slower* on Intel's MFT
    /// (SCREENS.md, Probe), so only the probe sets it — kept so the claim can
    /// be measured again on another machine.
    pub rgb: bool,
}

/// One encoded access unit.
pub struct Encoded {
    pub annex_b: Vec<u8>,
    pub key: bool,
    /// The sample time it was submitted with, in 100ns units: the capture's
    /// wall clock, so the hub can stamp `capture_us` without a side table.
    pub time: i64,
    pub at: std::time::Instant,
    /// How long the encoder held it: from `ProcessInput` to the output.
    pub held: Option<std::time::Duration>,
}

#[cfg(windows)]
pub use os::*;

#[cfg(windows)]
mod os {
    use super::{Encoded, Settings};
    use crate::cast::gpu::Gpu;
    use std::mem::ManuallyDrop;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread::JoinHandle;
    use windows::core::{Interface, Result, GUID};
    use windows::Win32::Graphics::Direct3D11::{ID3D11Texture2D, D3D11_BIND_RENDER_TARGET};
    use windows::Win32::Media::MediaFoundation::*;
    use windows::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, COINIT_MULTITHREADED};
    use windows::Win32::System::Variant::{VARIANT, VARIANT_0_0, VT_BOOL, VT_UI4};

    /// MF is started once per process and never stopped: `MFShutdown` while
    /// another thread still holds an encoder is a crash, and the cost of
    /// leaving it up is nothing.
    pub fn start() -> Result<()> {
        static STARTED: std::sync::OnceLock<std::result::Result<(), String>> = std::sync::OnceLock::new();
        STARTED
            .get_or_init(|| unsafe { MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET) }.map_err(|e| e.to_string()))
            .clone()
            .map_err(|e| windows::core::Error::new(windows::Win32::Foundation::E_FAIL, e))
    }

    /// Join the MTA on this thread. Every thread in `cast` that touches COM
    /// does this first; the objects are free-threaded, which is what lets the
    /// capture thread feed an encoder whose events another thread hears.
    pub fn mta() {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
    }

    pub fn variant_u32(v: u32) -> VARIANT {
        let mut var = VARIANT::default();
        unsafe {
            let inner: &mut VARIANT_0_0 = &mut var.Anonymous.Anonymous;
            inner.vt = VT_UI4;
            inner.Anonymous.ulVal = v;
        }
        var
    }

    pub fn variant_bool(v: bool) -> VARIANT {
        let mut var = VARIANT::default();
        unsafe {
            let inner: &mut VARIANT_0_0 = &mut var.Anonymous.Anonymous;
            inner.vt = VT_BOOL;
            inner.Anonymous.boolVal = windows::Win32::Foundation::VARIANT_BOOL(if v { -1 } else { 0 });
        }
        var
    }

    /// A hardware H.264 encoder Media Foundation offers, before it is made.
    pub struct Candidate {
        pub activate: IMFActivate,
        pub name: String,
        /// The adapter it was enumerated for, when it was asked by adapter.
        pub luid: Option<u64>,
        /// `VEN_8086`, `VEN_10DE`: who made it, for the probe's report.
        pub vendor: Option<String>,
    }

    unsafe impl Send for Candidate {}

    fn string_attr(a: &IMFAttributes, key: &GUID) -> Option<String> {
        unsafe {
            let len = a.GetStringLength(key).ok()?;
            let mut buf = vec![0u16; len as usize + 1];
            a.GetString(key, &mut buf, None).ok()?;
            Some(String::from_utf16_lossy(&buf[..len as usize]))
        }
    }

    fn take(list: *mut Option<IMFActivate>, count: u32, luid: Option<u64>) -> Result<Vec<Candidate>> {
        let mut out = Vec::new();
        for i in 0..count as usize {
            // SAFETY: the enumeration handed back `count` activates; we take each.
            if let Some(activate) = unsafe { std::ptr::replace(list.add(i), None) } {
                let attrs: IMFAttributes = activate.cast()?;
                out.push(Candidate {
                    name: string_attr(&attrs, &MFT_FRIENDLY_NAME_Attribute).unwrap_or_else(|| "unnamed encoder".into()),
                    vendor: string_attr(&attrs, &MFT_ENUM_HARDWARE_VENDOR_ID_Attribute),
                    luid,
                    activate,
                });
            }
        }
        if !list.is_null() {
            unsafe { CoTaskMemFree(Some(list as *const _)) };
        }
        Ok(out)
    }

    /// Hardware NV12 → H.264 encoders, in Media Foundation's own merit order:
    /// every one there is with `None`, or only those on one adapter.
    ///
    /// **The adapter is a filter, not an attribute.** Measured on the hybrid
    /// laptop: the activates `MFTEnumEx` hands back carry no
    /// `MFT_ENUM_ADAPTER_LUID` at all, so "match the LUID" has to be asked of
    /// `MFTEnum2`, which takes it as a blob. That is what keeps the panel's
    /// frames on Intel's encoder instead of NVIDIA's, which sorts first and
    /// cannot see a texture on another adapter.
    ///
    /// Software is deliberately absent: at 1440p it costs a core per screen and
    /// its latency is a frame or more, which is the thing this exists not to do.
    pub fn hardware_h264(luid: Option<u64>) -> Result<Vec<Candidate>> {
        start()?;
        let input = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: MFVideoFormat_NV12 };
        let output = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: MFVideoFormat_H264 };
        let flags = MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER;
        let mut list: *mut Option<IMFActivate> = std::ptr::null_mut();
        let mut count = 0u32;
        match luid {
            None => unsafe { MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER, flags, Some(&input), Some(&output), &mut list, &mut count)? },
            Some(l) => unsafe {
                let mut a = None;
                MFCreateAttributes(&mut a, 1)?;
                let a = a.expect("attributes");
                let mut blob = [0u8; 8];
                blob[..4].copy_from_slice(&(l as u32).to_le_bytes());
                blob[4..].copy_from_slice(&((l >> 32) as u32).to_le_bytes());
                a.SetBlob(&MFT_ENUM_ADAPTER_LUID, &blob)?;
                MFTEnum2(MFT_CATEGORY_VIDEO_ENCODER, flags, Some(&input), Some(&output), &a, &mut list, &mut count)?;
            },
        }
        take(list, count, luid)
    }

    /// The input formats an encoder lists once given an H.264 output type, as
    /// FourCCs — the probe's question of whether a frame could skip our own
    /// conversion and go in as the BGRA the desktop already is.
    pub fn input_subtypes(t: &IMFTransform) -> Vec<String> {
        let s = Settings { w: 1280, h: 720, fps: 60, kbps: 4000, rgb: false };
        unsafe {
            let _ = t.GetAttributes().and_then(|a| a.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1));
            if let Ok(o) = output_type(&s) {
                let _ = t.SetOutputType(0, &o, 0);
            }
        }
        let mut out = Vec::new();
        for i in 0..32 {
            let Ok(mt) = (unsafe { t.GetInputAvailableType(0, i) }) else { break };
            if let Ok(g) = unsafe { mt.GetGUID(&MF_MT_SUBTYPE) } {
                let cc = g.data1.to_le_bytes();
                out.push(if cc.iter().all(|c| c.is_ascii_graphic()) { String::from_utf8_lossy(&cc).into_owned() } else { format!("{:?}", g) });
            }
        }
        out
    }

    struct Pending {
        sample: IMFSample,
        key: bool,
    }

    struct State {
        credits: u32,
        pending: Option<Pending>,
        bitrate_dirty: Option<u32>,
    }

    struct Shared {
        transform: IMFTransform,
        codec: ICodecAPI,
        input_id: u32,
        output_id: u32,
        provides_samples: bool,
        out_size: u32,
        state: Mutex<State>,
        stopped: AtomicBool,
        /// When each sample time went in, so an output can say how long the
        /// encoder itself took — the number that separates "the GPU is slow"
        /// from "we fed it late".
        fed: Mutex<std::collections::VecDeque<(i64, std::time::Instant)>>,
    }

    // SAFETY: the MFT is asynchronous and therefore free-threaded by contract;
    // both threads that call it are MTA, and input is serialised by `state`.
    unsafe impl Send for Shared {}
    unsafe impl Sync for Shared {}

    impl Shared {
        /// Feed one frame. Called with the state lock held, so the credit and
        /// the call are one step.
        fn feed(&self, p: Pending, st: &mut State) -> Result<()> {
            unsafe {
                if let Some(bps) = st.bitrate_dirty.take() {
                    let _ = self.codec.SetValue(&CODECAPI_AVEncCommonMeanBitRate, &variant_u32(bps));
                }
                if p.key {
                    let _ = self.codec.SetValue(&CODECAPI_AVEncVideoForceKeyFrame, &variant_u32(1));
                }
                let time = p.sample.GetSampleTime().unwrap_or(0);
                let mut fed = self.fed.lock().unwrap();
                if fed.len() > 32 {
                    fed.pop_front();
                }
                fed.push_back((time, std::time::Instant::now()));
                drop(fed);
                self.transform.ProcessInput(self.input_id, &p.sample, 0)
            }
        }
    }

    /// A hardware encoder for one rendition, at one size.
    pub struct Encoder {
        shared: Arc<Shared>,
        allocator: IMFVideoSampleAllocatorEx,
        activate: IMFActivate,
        events: Option<JoinHandle<()>>,
        pub name: String,
        pub settings: Settings,
    }

    unsafe impl Send for Encoder {}

    /// A frame's worth of encoder input: the sample, and the texture inside it
    /// the scaler draws into.
    pub struct Slot {
        pub sample: IMFSample,
        pub texture: ID3D11Texture2D,
        pub index: u32,
    }

    pub enum Fed {
        /// Handed to the encoder now.
        Now,
        /// Kept as the one pending frame; the next `NeedInput` takes it.
        Pending,
    }

    /// Name the step that failed: an MFT's refusal is an HRESULT and nothing
    /// else, and `E_UNEXPECTED` from setup says nothing about which part of it.
    fn at<T>(r: Result<T>, what: &str) -> Result<T> {
        r.map_err(|e| windows::core::Error::new(e.code(), format!("{what}: {}", e.message())))
    }

    fn set_codec(codec: &ICodecAPI, api: &GUID, v: VARIANT) -> bool {
        let r = unsafe { codec.SetValue(api, &v) };
        if let Err(e) = &r {
            log::info!("cast: encoder declined {api:?}: {e}");
        }
        r.is_ok()
    }

    fn output_type(s: &Settings) -> Result<IMFMediaType> {
        unsafe {
            let t = MFCreateMediaType()?;
            t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
            t.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264)?;
            t.SetUINT32(&MF_MT_AVG_BITRATE, s.kbps * 1000)?;
            t.SetUINT64(&MF_MT_FRAME_SIZE, ((s.w as u64) << 32) | s.h as u64)?;
            t.SetUINT64(&MF_MT_FRAME_RATE, ((s.fps.max(1) as u64) << 32) | 1)?;
            t.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, (1u64 << 32) | 1)?;
            t.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
            t.SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High.0 as u32)?;
            // What the scaler produced: BT.709, limited range. Said in the VUI.
            t.SetUINT32(&MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709.0 as u32)?;
            t.SetUINT32(&MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709.0 as u32)?;
            t.SetUINT32(&MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709.0 as u32)?;
            t.SetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235.0 as u32)?;
            Ok(t)
        }
    }

    fn input_type(s: &Settings) -> Result<IMFMediaType> {
        unsafe {
            let t = MFCreateMediaType()?;
            t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
            t.SetGUID(&MF_MT_SUBTYPE, if s.rgb { &MFVideoFormat_ARGB32 } else { &MFVideoFormat_NV12 })?;
            t.SetUINT64(&MF_MT_FRAME_SIZE, ((s.w as u64) << 32) | s.h as u64)?;
            t.SetUINT64(&MF_MT_FRAME_RATE, ((s.fps.max(1) as u64) << 32) | 1)?;
            t.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, (1u64 << 32) | 1)?;
            t.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
            t.SetUINT32(&MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709.0 as u32)?;
            t.SetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235.0 as u32)?;
            Ok(t)
        }
    }

    impl Encoder {
        /// Make the first hardware encoder that runs on `gpu`'s adapter.
        /// `on_output` is called on the encoder's event thread for every
        /// access unit, and must not block.
        pub fn new(gpu: &Gpu, settings: Settings, on_output: Box<dyn FnMut(Encoded) + Send>) -> Result<Encoder> {
            let pick = hardware_h264(Some(gpu.luid))?
                .into_iter()
                .next()
                .ok_or_else(|| windows::core::Error::new(windows::Win32::Foundation::E_FAIL, "no hardware H.264 encoder on this adapter"))?;
            Encoder::with(gpu, pick, settings, on_output)
        }

        pub fn with(gpu: &Gpu, pick: Candidate, settings: Settings, on_output: Box<dyn FnMut(Encoded) + Send>) -> Result<Encoder> {
            start()?;
            let activate = pick.activate;
            let transform: IMFTransform = at(unsafe { activate.ActivateObject() }, "activating it")?;
            let attrs = unsafe { transform.GetAttributes()? };
            unsafe {
                at(attrs.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1), "unlocking the async MFT")?;
                let _ = attrs.SetUINT32(&MF_LOW_LATENCY, 1);
                at(transform.ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, gpu.manager.as_raw() as usize), "handing it the device")?;
            }
            let codec: ICodecAPI = transform.cast()?;
            /* Before the types: some encoders fix their rate control and GOP
               structure when the output type is set. */
            set_codec(&codec, &CODECAPI_AVLowLatencyMode, variant_bool(true));
            set_codec(&codec, &CODECAPI_AVEncCommonRateControlMode, variant_u32(eAVEncCommonRateControlMode_CBR.0 as u32));
            set_codec(&codec, &CODECAPI_AVEncCommonMeanBitRate, variant_u32(settings.kbps * 1000));
            set_codec(&codec, &CODECAPI_AVEncMPVDefaultBPictureCount, variant_u32(0));
            /* "Infinite": an hour at 120 fps. A GOP of 0 means *default* to
               some encoders rather than infinite, which is a keyframe every
               second or two — a bitrate spike a screen at rest pays for
               nothing. Keyframes come on demand instead. */
            set_codec(&codec, &CODECAPI_AVEncMPVGOPSize, variant_u32(432_000));

            let (mut input_id, mut output_id) = (0u32, 0u32);
            unsafe {
                let _ = transform.GetStreamIDs(std::slice::from_mut(&mut input_id), std::slice::from_mut(&mut output_id));
                at(transform.SetOutputType(output_id, &output_type(&settings)?, 0), "the output type")?;
                at(transform.SetInputType(input_id, &input_type(&settings)?, 0), "the input type")?;
            }
            let info = unsafe { transform.GetOutputStreamInfo(output_id)? };
            let provides_samples = info.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32 != 0;

            let allocator: IMFVideoSampleAllocatorEx = unsafe {
                let mut raw = std::ptr::null_mut();
                MFCreateVideoSampleAllocatorEx(&IMFVideoSampleAllocatorEx::IID, &mut raw)?;
                IMFVideoSampleAllocatorEx::from_raw(raw)
            };
            unsafe {
                allocator.SetDirectXManager(&gpu.manager)?;
                let mut a = None;
                MFCreateAttributes(&mut a, 2)?;
                let a = a.expect("attributes");
                a.SetUINT32(&MF_SA_D3D11_BINDFLAGS, D3D11_BIND_RENDER_TARGET.0 as u32)?;
                /* Enough for the encoder to hold a few while the scaler fills
                   the next; more is latency hiding in a pool. */
                at(allocator.InitializeSampleAllocatorEx(2, 6, &a, &input_type(&settings)?), "the sample pool")?;
                at(transform.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0), "beginning to stream")?;
                transform.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)?;
            }

            let shared = Arc::new(Shared {
                transform,
                codec,
                input_id,
                output_id,
                provides_samples,
                out_size: info.cbSize.max(1 << 20),
                state: Mutex::new(State { credits: 0, pending: None, bitrate_dirty: None }),
                stopped: AtomicBool::new(false),
                fed: Mutex::default(),
            });
            let generator: IMFMediaEventGenerator = shared.transform.cast()?;
            let gen = SendBox(generator);
            let thread_shared = shared.clone();
            let events = std::thread::Builder::new()
                .name("cast-encoder".into())
                .spawn(move || {
                    mta();
                    crate::cast::capture::urgent();
                    event_loop(thread_shared, gen, on_output);
                })
                .map_err(|e| windows::core::Error::new(windows::Win32::Foundation::E_FAIL, e.to_string()))?;
            Ok(Encoder { shared, allocator, activate, events: Some(events), name: pick.name, settings })
        }

        /// A free input sample, or `None` while the encoder holds them all —
        /// the frame is then skipped, which is the right thing for a screen.
        pub fn slot(&self) -> Option<Slot> {
            unsafe {
                let sample = self.allocator.AllocateSample().ok()?;
                let buffer = sample.GetBufferByIndex(0).ok()?;
                let dxgi: IMFDXGIBuffer = buffer.cast().ok()?;
                let mut raw = std::ptr::null_mut();
                dxgi.GetResource(&ID3D11Texture2D::IID, &mut raw).ok()?;
                let texture = ID3D11Texture2D::from_raw(raw);
                let index = dxgi.GetSubresourceIndex().ok()?;
                Some(Slot { sample, texture, index })
            }
        }

        /// Hand a filled slot to the encoder. `time` is in 100ns units and
        /// comes back on the output.
        pub fn submit(&self, slot: Slot, time: i64, duration: i64, key: bool) -> Result<Fed> {
            unsafe {
                slot.sample.SetSampleTime(time)?;
                slot.sample.SetSampleDuration(duration)?;
            }
            let mut st = self.shared.state.lock().unwrap();
            let p = Pending { sample: slot.sample, key: key || st.pending.as_ref().is_some_and(|p| p.key) };
            if st.credits > 0 {
                st.credits -= 1;
                st.pending = None;
                self.shared.feed(p, &mut st)?;
                Ok(Fed::Now)
            } else {
                st.pending = Some(p);
                Ok(Fed::Pending)
            }
        }

        /// Change the bitrate on the fly; taken with the next frame fed.
        pub fn set_kbps(&mut self, kbps: u32) {
            self.settings.kbps = kbps;
            self.shared.state.lock().unwrap().bitrate_dirty = Some(kbps * 1000);
        }
    }

    impl Drop for Encoder {
        fn drop(&mut self) {
            self.shared.stopped.store(true, Ordering::SeqCst);
            unsafe {
                if let Ok(s) = self.shared.transform.cast::<IMFShutdown>() {
                    let _ = s.Shutdown();
                }
            }
            if let Some(t) = self.events.take() {
                let _ = t.join();
            }
            unsafe {
                let _ = self.activate.ShutdownObject();
            }
        }
    }

    struct SendBox<T>(T);
    unsafe impl<T> Send for SendBox<T> {}

    fn event_loop(shared: Arc<Shared>, gen: SendBox<IMFMediaEventGenerator>, mut on_output: Box<dyn FnMut(Encoded) + Send>) {
        let gen = gen.0;
        let trace = std::env::var_os("CAST_TRACE").is_some();
        let t0 = std::time::Instant::now();
        while !shared.stopped.load(Ordering::SeqCst) {
            let event = match unsafe { gen.GetEvent(MEDIA_EVENT_GENERATOR_GET_EVENT_FLAGS(0)) } {
                Ok(e) => e,
                Err(e) => {
                    if !shared.stopped.load(Ordering::SeqCst) {
                        log::warn!("cast: encoder event queue ended: {e}");
                    }
                    return;
                }
            };
            let kind = unsafe { event.GetType() }.unwrap_or(0);
            if trace {
                let st = shared.state.lock().unwrap();
                log::info!("cast trace {:8.2}ms event {kind} credits {} pending {} fed-not-out {}", t0.elapsed().as_secs_f64() * 1000.0, st.credits, st.pending.is_some(), shared.fed.lock().unwrap().len());
            }
            if kind == METransformNeedInput.0 as u32 {
                let mut st = shared.state.lock().unwrap();
                match st.pending.take() {
                    Some(p) => {
                        if let Err(e) = shared.feed(p, &mut st) {
                            log::warn!("cast: encoder refused a frame: {e}");
                        }
                    }
                    None => st.credits += 1,
                }
            } else if kind == METransformHaveOutput.0 as u32 {
                match pull(&shared) {
                    Ok(Some(out)) => on_output(out),
                    Ok(None) => {}
                    Err(e) => log::warn!("cast: encoder output failed: {e}"),
                }
            }
        }
    }

    fn pull(shared: &Shared) -> Result<Option<Encoded>> {
        let given = if shared.provides_samples {
            None
        } else {
            unsafe {
                let s = MFCreateSample()?;
                s.AddBuffer(&MFCreateMemoryBuffer(shared.out_size)?)?;
                Some(s)
            }
        };
        let mut buf = MFT_OUTPUT_DATA_BUFFER {
            dwStreamID: shared.output_id,
            pSample: ManuallyDrop::new(given),
            dwStatus: 0,
            pEvents: ManuallyDrop::new(None),
        };
        let mut status = 0u32;
        let r = unsafe { shared.transform.ProcessOutput(0, std::slice::from_mut(&mut buf), &mut status) };
        let sample = unsafe { ManuallyDrop::take(&mut buf.pSample) };
        drop(unsafe { ManuallyDrop::take(&mut buf.pEvents) });
        if let Err(e) = r {
            if e.code() == MF_E_TRANSFORM_STREAM_CHANGE {
                // The encoder renegotiated its output; take what it offers.
                unsafe {
                    let t = shared.transform.GetOutputAvailableType(shared.output_id, 0)?;
                    shared.transform.SetOutputType(shared.output_id, &t, 0)?;
                }
                return Ok(None);
            }
            return Err(e);
        }
        let Some(sample) = sample else { return Ok(None) };
        let at = std::time::Instant::now();
        unsafe {
            let buffer = sample.ConvertToContiguousBuffer()?;
            let mut ptr = std::ptr::null_mut();
            let mut len = 0u32;
            buffer.Lock(&mut ptr, None, Some(&mut len))?;
            let annex_b = std::slice::from_raw_parts(ptr, len as usize).to_vec();
            buffer.Unlock()?;
            let key = sample.GetUINT32(&MFSampleExtension_CleanPoint).map(|v| v != 0).unwrap_or(false) || super::is_idr(&annex_b);
            let time = sample.GetSampleTime().unwrap_or(0);
            let mut fed = shared.fed.lock().unwrap();
            let held = fed.iter().position(|f| f.0 == time).map(|i| {
                let t = fed[i].1;
                fed.drain(..=i);
                at.duration_since(t)
            });
            Ok(Some(Encoded { annex_b, key, time, at, held }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPS: [u8; 5] = [0x67, 0x64, 0x00, 0x2a, 0xac];
    const PPS: [u8; 3] = [0x68, 0xee, 0x3c];
    const IDR: [u8; 3] = [0x65, 0x88, 0x84];
    const P: [u8; 3] = [0x41, 0x9a, 0x02];

    fn annex(units: &[&[u8]]) -> Vec<u8> {
        let mut out = Vec::new();
        for (i, u) in units.iter().enumerate() {
            out.extend_from_slice(if i == 0 { &[0, 0, 0, 1][..] } else { &[0, 0, 1][..] });
            out.extend_from_slice(u);
        }
        out
    }

    #[test]
    fn nal_units_split_on_three_and_four_byte_start_codes() {
        let b = annex(&[&SPS, &PPS, &IDR]);
        let units = nals(&b);
        assert_eq!(units.iter().map(|u| u.0).collect::<Vec<_>>(), vec![7, 8, 5]);
        assert_eq!(units[0].1, &SPS);
        assert!(is_idr(&b));
        assert!(!is_idr(&annex(&[&P])));
    }

    #[test]
    fn the_codec_string_comes_off_the_sps() {
        assert_eq!(codec_string(&annex(&[&SPS, &PPS, &IDR])).as_deref(), Some("avc1.64002a"));
        assert_eq!(codec_string(&annex(&[&P])), None);
    }

    #[test]
    fn an_idr_without_parameter_sets_gets_the_last_ones_seen() {
        let mut ps = ParamSets::default();
        let first = annex(&[&SPS, &PPS, &IDR]);
        assert!(matches!(ps.ensure(&first), Cow::Borrowed(_)));
        let delta = annex(&[&P]);
        assert!(matches!(ps.ensure(&delta), Cow::Borrowed(_)));
        let bare = annex(&[&IDR]);
        let fixed = ps.ensure(&bare).into_owned();
        assert_eq!(nals(&fixed).iter().map(|u| u.0).collect::<Vec<_>>(), vec![7, 8, 5]);
    }
}
