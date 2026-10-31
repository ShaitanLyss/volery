---
paths:
  - "src/lib/cast.ts"
  - "src/lib/cast.worker.ts"
  - "src/lib/cast.svelte.ts"
  - "src/lib/Screen.svelte"
  - "src/lib/ScreenFocus.svelte"
  - "src/lib/ScreenGrid.svelte"
  - "src/lib/ScreenSheet.svelte"
  - "src/lib/ScreenFloats.svelte"
  - "src/lib/ScreenMark.svelte"
  - "tools/castlab.ts"
  - "tools/cast-relay.ts"
  - "src-tauri/src/cast/mod.rs"
  - "src-tauri/src/cast/gpu.rs"
  - "src-tauri/src/cast/capture.rs"
  - "src-tauri/src/cast/encode.rs"
  - "src-tauri/src/cast/hub.rs"
  - "src-tauri/src/cast/local.rs"
  - "src-tauri/src/cast/monitors.rs"
  - "src-tauri/src/cast/exclude.rs"
  - "src-tauri/examples/cast-probe.rs"
---

# Screens on the wall — the front end

A machine's monitor, live and drivable, on the wall and in chat view. `docs/SCREENS.md` is the
contract the four lanes build against (the bytes, the adaptive table, who owns which file);
this is why the webview half is shaped as it is.

## Neither main thread touches a frame

The socket and the `VideoDecoder` are a Worker's (`cast.worker.ts`), and it paints onto an
`OffscreenCanvas` the tile transferred to it. What reaches the wall's JS thread is a state word, a
config, a stats line twice a second and a cursor's CSS when its shape changes — the same argument
`pane.svelte.ts` makes for the browser's CDP socket, with an encoded stream instead of JPEGs.

- **Newest frame or nothing.** A decoder with more than one frame queued drops deltas to the next
  keyframe and asks for one (`{"t":"key"}`, at most twice a second); a keyframe that arrives while
  it is behind resets the queue and goes straight in. A decoder that errors is rebuilt, falling to
  software once if the hardware refused the stream. A queue is latency, and a stale frame is worth
  nothing in a remote desktop.
- **Every `VideoFrame` is closed the moment it is on the glass.** A decoder's output pool is
  small; one frame held open stalls it, which looks exactly like a frozen network.
- **Two canvases per surface**, picture and cursor, so a pointer moving over a still screen
  redraws a cursor and not a frame — and so no decoded frame is kept open to redraw under it.
- **The 2d painter, measured rather than argued.** `tools/castlab.ts` (below) against both:
  `drawImage(frame)` and `bitmaprenderer` + `createImageBitmap` each cost 0.6–0.8 ms of worker CPU
  a frame on this machine, and the bitmap path's async hop shows up as latency. `cast.svelte.ts`
  `PAINT` is the switch if a GPU ever says otherwise.

## One holder, one tile, many surfaces

`casts` (`cast.svelte.ts`) is a **module singleton**, the `deck`/`chronicle` arrangement, because
three surfaces in unrelated subtrees reach the same sessions — the wall's widget, chat view's sheet
and sidebar, and the root overlays. Threading it through `Canvas` and `WidgetNode` for one of them
would be the prop CLAUDE.md warns about. A session is keyed by a string: a widget's id, or
`chat:` / `grid:` / `float:` and the screen key, so each surface has its own socket and the
host's two-renditions rule decides what that costs.

**`Screen.svelte` is the one tile** — the widget face, the sheet, a grid cell (`onopen`, which
opens rather than drives) and a vignette. Three copies of the drive listeners would be three places
for the first-click rule or the Escape rule to drift.

**The want is decided in the holder, from facts no face sees together**: the tile's box × the
wall's zoom × `devicePixelRatio`, one `IntersectionObserver` for every tile (which also reads chat
view's `display: none` as off screen), whether immersive is covering the window, the `calm`
reading and whether it is being driven. `cast.ts::want` snaps sizes up a quarter-octave ladder and
`sameWant` drops repeats, so panning costs nothing and zooming asks for a new rendition — a
keyframe, the dearest frame there is — only every ~19%.

### The effect loop the lab found

The first lab run drew every tile stuck on *connecting…* and logged
`effect_update_depth_exceeded`. The tile's attachment called `casts.attach`, which resolves the
`primary` role by **reading** `casts.monitors` and, finding it empty, **writes** it — inside the
attachment's own effect, which therefore re-ran on its own write, tore the session down and built
it again. Unit tests cannot see this (no runes in Bun), and `svelte-check` is silent about it.
**Every holder call made from an effect or an attachment is `untrack`ed whole**, not just its
arguments, and each effect reads only its own props first. The holder's own view effect does the
same. Anything added to the holder that reads state on its way to writing some owes the same.

## Driving

- **The first click into a tile that does not have focus only takes focus.** On a wall you drag
  things across, a press that lands on somebody's desktop because it started a few pixels to the
  right is a click nobody meant.
- **Escape is the machine's, and holding it is the way out** — Lyss's pick on 2026-10-31, over a
  three-modifier chord and an RDP-style top bar (asked with pictures). `cast.ts::EscapeHold`: nothing
  is sent at keydown; a release inside `HOLD_MS` sends the tap whole, a hold leaves without the
  machine ever seeing an Escape, and a ring fills while you hold. The same gesture lets go of a
  tile and leaves immersive. It reads `e.key` as well as `e.code`, because the control surface's
  `key` op sends no code.
- **Everything held is lifted on the way out** — blur, a hidden window, leaving immersive:
  `castinput.ts::releaseAll`. A key-up that never arrives is a key held down for ever.
- **The driven pointer is the OS's own**, wearing the remote shape as a CSS `cursor: url(...)`
  the worker built (`cast.ts::cursorCss`, a stored-deflate PNG, clamped to Chromium's 128 px), so
  it moves at the hardware's rate rather than a frame behind your hand.

## Immersive, the grid and chat view

- **Immersive** (`ScreenFocus.svelte`) is a root overlay over either view that *borrows* the open
  session: the worker is handed two more canvases and paints there until released. A surface swap
  and a `focused` want, never a second socket.
- **Chat view** (Lyss, 2026-10-31): a *screens* group in the sidebar; choosing one shows it live
  and drivable in the sheet with the list still beside it (`casts.sheet`); *all screens* is a live
  grid of every screen on the flyway; immersive is one more click. Choosing a conversation, a pile
  or a project clears the sheet, and the bar names what is in it.
- **The grid** (`ScreenGrid.svelte`) is the same component in the sheet and over the wall
  (`space r a`), where Escape closes it unless immersive is up.
- **Vignettes** (`ScreenFloats.svelte`) are chat view's alone — on the wall the same thing is a
  screen widget on the glass. Placed from the window's bottom-right so a smaller window keeps them
  in reach, kept in `localStorage` beside the view.
- **The host's mark** (`ScreenMark.svelte`) is drawn at the root from `cast:watched`: no colour
  while only watched, amber while driven.

## Building it without the real host

`tools/cast-relay.ts` is a stand-in loopback socket and `tools/castlab.html`/`.ts` a fake host:
a scene encoded by WebCodecs as Annex-B H.264 into exactly `wire.rs`'s messages, obeying wants and
key requests, plus the real worker beside it. A **debug** build dials the relay instead of
`cast_open` when `VITE_CAST_RELAY` is set in the lab's environment
(`$env:VITE_CAST_RELAY="ws://127.0.0.1:14399"; bun run lab <name>`) or `skein.cast.relay` is in
`localStorage`, and offers one monitor called *castlab*. An installed build never honours either.
Run vite for castlab on a port of your own (`bun x vite --port 1499`), never 1420.

# The host half — capture, encode, the hub and the loopback socket

`examples/cast-probe.rs` drives the same `gpu`/`capture`/`encode` code the hub does and is how
every number below was taken; `docs/SCREENS.md`'s *Probe* section has the table. Run it again
after touching any of them — a probe that measures a rehearsal of the code measures nothing.

## The adapter that owns the output, and nothing else

Desktop Duplication works only on a device made on the adapter that drives the output. On the
hybrid laptop that is the Intel iGPU; the RTX 4080 reports `outputs=0`. So a monitor's id *is*
its adapter LUID and output index (`monitors.rs`), and the encoder is the one Media Foundation
offers **for that LUID**. The LUID is a *filter*, not an attribute: the activates `MFTEnumEx`
hands back carry no `MFT_ENUM_ADAPTER_LUID` at all on this machine, so it is asked of
`MFTEnum2` as an 8-byte blob. Unfiltered, NVIDIA's MFT sorts first and would be handed a
texture it cannot see.

## The 15.6 ms that was not the encoder

Under continuous feed every frame spent a **whole multiple of 15.6 ms** inside Intel's encoder MFT
— 15, 30, 46, 61, never between — while a lone frame after a rest came back in 8 ms. That is the
default Windows timer tick: something on the driver's path sleeps on the coarse timer.
`capture::FineTimer` holds `timeBeginPeriod(1)` per capture thread (Windows 11 scopes it to the
asking process and only while asked). It took capture→encoded p50 from **47 ms to 14 ms** at
1440p and **44 ms to 8 ms** at 720p. Nothing else tried moved it: a `Flush()` after the video
processor's blt (kept — it is still correct to submit at once) and `SetGPUThreadPriority(7)`
(accepted, no measurable effect; kept as the scheduler's own word for latency-bound work).

## What did not help, so nobody tries it again blind

- **MMCSS / thread priority** on the capture, encoder and writer threads (`capture::urgent`): no
  measurable change in interleaved A/B runs. Kept because it is free and the CPU here is pinned more
  often than not; `CAST_NORMAL_PRIORITY` turns it off for the probe.
- **ARGB32 into the encoder** (`Settings::rgb`, probe only): Intel's MFT lists it, and it skips our
  conversion at native size, but its own conversion is dearer — p50 37–42 ms against NV12's 21–24.
- **The socket** was suspected of a 14 ms gap and holds none: the hub's `encode_ms` and the
  client's acquire→received agree to a millisecond.

## The iGPU is shared with everything you are looking at

During the probe Intel's 3D engine sat at ~100%: Chrome ~42%, the wall's own WebView2 ~42%,
DWM ~15%. The conversion (`ID3D11VideoProcessor`) queues behind them, which is the rest of the
1440p latency. That is why `gpu::Bridge` exists — carrying a frame to the 4080 through system
memory, measured rather than assumed (see SCREENS.md's *Probe*).

## NVENC, and choosing an encoder

- **NVIDIA's MFT will not activate in this process; NVENC's own API will.** `cast/nvenc.rs` is
  hand-written FFI to `nvEncodeAPI64.dll` (shipped with the driver, loaded at run time, API 12.1).
  **Its offsets are compiled, not counted**: a ten-line C program `offsetof`s every field it
  touches against FFmpeg's MIT `nv-codec-headers` tag `n12.1.14.0`, and the structs are zeroed
  buffers at least that large with the version word set. Moving to a newer API means re-running
  that program against the newer header, not editing numbers by eye.
- **A carry across adapters is two halves on two threads.** The capture thread queues a GPU copy
  into a staging texture on its own adapter and moves on; the NVENC thread maps it (which waits
  for the copy) and uploads. All of it on the capture thread cost 6 ms a frame and 11 fps.
- **`hub::choose` is the policy, and it is pure:** NVENC where NVIDIA owns the output (no copy),
  else the owner's MFT unless `CROSS_NVENC_WINS` (false; measured a tie, SCREENS.md *Probe*), else
  NVENC across adapters. `VOLERY_CAST_ENCODER=mf|nvenc` forces one where it can, and a refusal at
  start falls back to the other. `stats` names which one is running.
- NVENC converts BGRA itself using the matrix the **VUI** names, so the VUI fields set in
  `config_for` are also what make its colours right. The probe checks this by decoding a known
  green window.

## The encoder

- **Asynchronous by contract.** A thread per encoder blocks on its event queue: `NeedInput` is a
  credit, `HaveOutput` is a `ProcessOutput` and the fan-out. The capture thread feeds the moment a
  credit exists and otherwise leaves **one** pending frame, which a newer capture replaces.
- **Samples come from `IMFVideoSampleAllocatorEx`** bound to the device manager, so a texture
  goes back to the pool exactly when the encoder lets go of it; an empty pool skips the frame.
- **CBR, no B-frames, `AVLowLatencyMode`, GOP of 432 000** — a GOP of 0 means *default* to some
  encoders, which is a keyframe every second or two. Keyframes are forced
  (`AVEncVideoForceKeyFrame`) when a viewer joins or loses its place. Intel's MFT repeats SPS/PPS
  on every IDR as measured; `encode::ParamSets` prepends the last ones seen to an IDR that lacks
  them anyway, because a joining decoder with no `description` has nothing else to start from.
- **BT.709 limited range** out of the video processor, and said in the output type, so the VUI and
  the pixels agree.

## The hub

- One capture thread per monitor, started by the first `subscribe` and stopped by the last
  `Subscription` dropped. It owns the duplication, scalers and encoders; only finished bytes leave.
- `plan` collapses wants into **at most two renditions** — the largest wanted and a thumbnail for
  whoever wants half of that or less — on a fixed **ladder** of fractions of native size
  (`rung`), so a tile resized a few pixels does not rebuild an encoder. fps by the SCREENS.md
  table (`fps_for`); bitrate 0.08 bits per pixel per frame, bounded, under any viewer's `cap`.
- A joiner waits for a keyframe (deltas are not sent to it), gets the current cursor shape and
  position at once, and a `config` text before the first keyframe of every new shape.
- After motion stops, one more encode of the still frame 120 ms later: CBR under motion is soft,
  and the encoder only sharpens what it is fed.
- `ACCESS_LOST` re-duplicates; while that answers `E_ACCESSDENIED` the viewers are told
  `locked`. A new mode may be a new size, so the renditions are rebuilt from scratch.
- **Never drop an encoder while holding `source.subs`.** Its `Drop` joins the event thread, which
  may be inside `fan_out` waiting for that lock. The capture thread then waited for ever and every
  viewer of the monitor froze at its first rendition change (found by the flyway lane across two
  labs). Renditions a re-plan replaces go into `retired` and are dropped after the lock is let go.
  `cast-probe --serve` resizes mid-session and says so loudly if frames stop; with the drop put
  back inside the lock it stopped 2 runs out of 2.

## The socket

- `Outbox` is the drop-until-keyframe queue: more than two video frames waiting purges them all
  and drops deltas to the next keyframe, raising a key request the session turns into
  `Subscription::key`. Cursor positions coalesce. The flyway keeps its own (`cast::Behind`) because
  it also bounds in-flight QUIC streams.
- A session is two plain threads, reader and writer, on two `WebSocket`s over one cloned
  `TcpStream`. Nothing subscribes until the first `want`. A **local** session never injects:
  Volery covers the desktop it shows, so an injected click lands on Volery — local input goes
  only through the input lane's through-the-tile mode (`drive.rs`). A remote session's input goes
  to `RemoteSubscription::input`, and the far host holds the `inject::Driver`.
- `exclude::Hold` is taken by every **local** session and protects every webview window from
  capture while at least one is held.

### A lab cannot screenshot itself while it shows its own machine

`WDA_EXCLUDEFROMCAPTURE` is set on the wall's windows while it shows one of its own monitors, and
`PrintWindow` honours it like every other capture API: the lab capture script returns a solid
black window exactly when screens work. That black is the proof the wall is absent from its own
picture. The proof of what a tile draws is the control surface's `screen.peek`, which asks the
session's worker for its canvas as a PNG (`convertToBlob`) and returns it as a data URL, along with
what the session reports (state, stats, config). One frame crosses to the main thread because a
test asked, never per frame. A static screen reads `0 fps`, and that is honest: Desktop
Duplication sends nothing while nothing changes.
