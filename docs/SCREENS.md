# Screens on the wall

A machine's monitor, live on the wall, that you can drive — this laptop (minus Volery) and every
other machine on the flyway, several at once. Asked for on 2026-10-30: *"super performant and
optimized, akin to the likes of parsec … it should feel like I'm actually there and not remote."*

This file is the **contract** the lanes build against: who owns which file, and the bytes that
cross every boundary. When a lane learns something that changes a boundary, it changes it here
first, in the same commit as the code. The subsystem's reasoning — why each piece is shaped as
it is, and the probes behind it — goes to `.claude/rules/cast.md` once there is code to scope it
to.

## Decisions (Lyss, 2026-10-30)

- **Local control: through the tile**, for ordinary apps — click a button in a browser, type in
  a search field, press Enter. Games on the laptop are an Alt+Tab away and need not work through
  the tile. *Conditional on a probe* (input lane, step 1): if Volery's window cannot be made
  click-through for an instant without the webview flashing, the fallback is **step aside** —
  clicking into the tile puts you on the real desktop at that spot, a hotkey brings Volery back.
- **Consent: the "take work from other walls" switch.** A machine can be seen *and* driven from
  another wall exactly when it takes work. Read fresh on every session open, as `act.rs` reads
  it. No second switch. The host shows a quiet mark while it is watched or driven.
- **Controllers: later.** Not in this push. The input format reserves a kind for them.
- **Sound: yes, the focused screen only.** WASAPI loopback, Opus (the IETF audio codec, RFC
  6716 — not the model), decoded by WebCodecs' `AudioDecoder`. Last stage.

## The shape

```
HOST (the machine being shown)                       VIEWER (the wall you are at)
──────────────────────────────                       ──────────────────────────────
DXGI Desktop Duplication, per monitor                 Screen.svelte (widget face, tile)
  on the adapter that owns the output                   │ owns an OffscreenCanvas, reports
  → D3D11 VideoProcessor: BGRA→NV12 + scale             │ its device-pixel size + visibility
  → Media Foundation hardware H.264 (async MFT)         ▼
  → cast::hub fan-out, encoded ONCE per rendition      cast.worker.ts (Web Worker)
        │                    │                           WebSocket ─► VideoDecoder (hardware,
        │ local viewer       │ remote viewer             optimizeForLatency) ─► OffscreenCanvas
        ▼                    ▼                                    ▲
  cast::local (loopback     flyway media connection               │ ws://127.0.0.1:<port>
  WebSocket server)         (ALPN volery/cast/1) ──────► cast::local on the viewer's machine
```

**Neither main thread ever touches a frame.** Not Tauri's (CLAUDE.md: an emit is a push onto
the thread that delivers every card's events; a sync command runs on it), and not the wall's
JS thread (the transcript, the canvas, Svelte's reactivity). Bytes go capture thread → encoder
→ hub → a socket thread → loopback → a Worker → the GPU. Setup happens through `async`
commands (`crate::off_main`); everything per-frame happens off both main threads. The browser
pane already does this with Chrome's CDP socket (`pane.svelte.ts:15-23`); this is the same
argument with an encoded stream instead of JPEGs.

**The webview receives an encoded stream, not pixels**: ~1–6 MB/s per screen, decoded on the
GPU, and the decoded `VideoFrame` stays a GPU texture to the canvas. If measurement ever shows
the focused screen a frame or more behind Parsec, the fix is a *native presenter for focused
mode only* (a swapchain filling the window, where nothing on the wall overlaps it) — not
native tiles, which would sit above every menu and lag every pan.

**Local and remote are one path for the webview.** A tile always talks to its own machine's
`cast::local` socket; Rust decides whether the source is a local monitor or a flyway peer.

### Adaptive by construction

A tile reports its on-screen size in device pixels (`widget.w * scale * devicePixelRatio`) and
whether it is visible (IntersectionObserver on the wall, the view being the wall or chat view
showing it). The host encodes at `min(native, wanted)`, and:

| tile | fps | notes |
|---|---|---|
| focused (fills the window) | the monitor's refresh, capped 120 | full bitrate |
| visible | 30 | bitrate scaled to pixels |
| small (< 480 device px wide) | 15 | |
| not visible | 0 — paused | a keyframe on return |

So twenty machines on a zoomed-out wall cost twenty thumbnails, not twenty 1440p streams.
Several viewers of one monitor share one capture; at most **two renditions** per monitor are
encoded (the largest wanted, and a thumbnail), and a viewer takes the nearest.

### Seeing the laptop minus Volery

`WDA_EXCLUDEFROMCAPTURE` on Volery's own windows (Tauri's `set_content_protected(true)`; it is
`SetWindowDisplayAffinity` underneath and DWM honours it for Desktop Duplication too). Set
**only while this machine's own wall is showing one of its own monitors**, and cleared when
the last such tile closes — it also hides Volery from screenshots and screen sharing, which
must not be a permanent side effect of having once opened a tile. A remote wall viewing this
laptop while a local self-view is open also sees it without Volery; that is accepted.

## Lanes and the files each owns

| lane | owns | must not touch |
|---|---|---|
| **core** | `src-tauri/src/cast/{mod.rs,gpu.rs,capture.rs,encode.rs,hub.rs,local.rs,monitors.rs,exclude.rs}`, `examples/cast-probe.rs`, the `cast_*` commands in `lib.rs` | `cast/wire.rs` is shared — change it with a note here |
| **front** | `src/lib/cast.ts`, `src/lib/cast.worker.ts`, `src/lib/cast.svelte.ts`, `src/lib/Screen.svelte`, `src/lib/ScreenFocus.svelte`, the `screen` spec in `widgets.ts` + its arm in `WidgetNode.svelte`, chat view's screens tab, the leader chord, `test/cast.test.ts` | Rust |
| **input** | `src-tauri/src/cast/{inject.rs,drive.rs}`, `src/lib/castinput.ts` (+ `test/castinput.test.ts`), `tools/probe-drive.ts` or an example | `Screen.svelte` (hand front a function to call) |
| **flyway** | `src-tauri/src/flyway/cast.rs` (pure), `src-tauri/src/flyway/link/cast.rs` (wiring), the media connection in `flyway/wire.rs`, `Facts.screens` in `fleet.rs` | `cast/hub.rs` internals — use its API |

`src-tauri/Cargo.toml` already carries every `windows` feature the core lane needs (added with
this file), so no two lanes edit it at once. A lane needing another feature adds it alone and
says so on the billboard.

## The hub API (core owns, flyway and input call)

Defined in `cast/mod.rs`; the types are there now, the functions arrive with the core lane.

```rust
pub fn monitors() -> Vec<Monitor>;
pub fn subscribe(monitor: &str, want: Want, viewer: Arc<dyn Viewer>) -> Result<Subscription, String>;
impl Subscription { pub fn want(&self, w: Want); pub fn key(&self); }   // Drop unsubscribes
pub fn input(monitor: &str, events: &[Input]);                          // → inject.rs
```

`Viewer::send` is handed messages **already encoded to wire bytes** (`Out`), once per frame
however many viewers there are; the loopback socket and the flyway are dumb pipes over them.
**`send` must never block.** A viewer that falls behind drops frames until the next keyframe and
asks for one (`Subscription::key`) — a stale frame is worth nothing in a remote desktop, and a
queue is latency.

The flyway lane provides the same shape for a far machine:
`flyway::link::cast::subscribe(host, monitor, want, viewer) -> Result<RemoteSubscription, String>`,
with `want`, `key` and `input`.

## The loopback socket (core serves, front connects)

`invoke("cast_open", { host: string | null, monitor: string })` → `{ url }`, where `url` is
`ws://127.0.0.1:<port>/<session>?t=<token>`. The port is ephemeral, bound once per run; the
token is per session and the socket refuses anything without it (any local process can dial a
loopback port). The session lives exactly as long as the socket.

**All binary messages are little-endian.** Byte layouts are `cast/wire.rs`, with its tests; the
front's `cast.ts` must decode the same bytes and `test/cast.test.ts` holds fixtures copied from
`wire.rs`'s tests.

Host → viewer, **binary**:

| kind | layout | |
|---|---|---|
| `0x01` video | `kind u8, flags u8 (bit0 key), w u16, h u16, seq u32, capture_us u64, encoded_us u64`, then Annex-B H.264 | header 26 bytes. Times are the host's wall clock, µs since the Unix epoch |
| `0x02` cursor shape | `kind u8, 0 u8, w u16, h u16, hot_x u16, hot_y u16, shape u32`, then `w*h*4` RGBA, straight alpha | sent once per new shape |
| `0x03` cursor position | `kind u8, visible u8, x i16, y i16, shape u32` | source pixels, top-left of the monitor |
| `0x04` audio | reserved for the sound stage | |

Host → viewer, **text** (JSON): `{"t":"config","codec":"avc1.64002a","w":…,"h":…,"fps":…}`
before the first keyframe of every new shape; `{"t":"state","state":"live|paused|locked|ended|refused","why":"…"}`;
`{"t":"stats",…}` (free-form, for the overlay).

The cursor is drawn **by the viewer**, from shape + position, never baked into the video:
the local pointer moves at the viewer's own refresh rate whatever the stream is doing, which
is most of what makes a remote desktop feel like it isn't one.

Viewer → host, **text** (JSON): `{"t":"want","w","h","fps","visible","focused"}`,
`{"t":"key"}` (decoder lost its place), `{"t":"drive","on":bool}` (local through-the-tile).

Viewer → host, **binary**: one or more input events, concatenated:

| kind | layout | |
|---|---|---|
| `0x11` mouse absolute | `x u16, y u16` | normalized 0..=65535 over the source monitor |
| `0x12` mouse relative | `dx i16, dy i16` | pointer-locked, raw counts |
| `0x13` button | `button u8, down u8` | 0 left, 1 right, 2 middle, 3 back, 4 forward |
| `0x14` wheel | `dx i16, dy i16` | 120 per notch, Windows' sign |
| `0x15` key | `scan u16, down u8` | PS/2 set-1 make code; `0xE0xx` for extended keys. Scancodes, not virtual keys: layout-independent and what games read |
| `0x16` release all | — | sent on blur: lift every held key and button |
| `0x17` pad | reserved for controllers | |

## The flyway media channel (flyway lane)

The flyway today opens a fresh QUIC connection per exchange and carries sealed JSON
(`flyway/wire.rs`); a held-open connection was deferred until something would pay for it
(`link.rs:47-52`). A screen does. So: **one long-lived connection per (viewer wall, host wall)
pair while any screen between them is open**, on its own ALPN `volery/cast/1` (the `answer`
branch at `wire.rs:249` must learn it), following the link's tenure so leaving closes it.

- video frames: one QUIC **unidirectional stream per frame**, so a lost packet delays one frame
  and never the ones behind it; a frame superseded by a newer keyframe is reset.
- control (want / key / state / config): a bidirectional stream of length-prefixed sealed JSON.
- input: QUIC **datagrams** (unreliable — a mouse move that arrives late is worse than one that
  does not arrive), except key and button events, which go on the control stream: a lost
  key-up is a key held down forever.
- sealing as `seal.rs` does, with the key object built once per connection, not per frame.
- bitrate follows the path: the host reads the connection's RTT and loss and steers the encoder.
- **direct vs relay is shown on the tile.** Through n0's relay the code's own assumption is
  ~1 Mbit/s (`look.rs:91-94`) and an office network running Netskope may block UDP outright
  (`docs/FLYWAY-PROBE.md`). A relayed screen degrades to what fits and *says so* rather than
  stuttering silently.
- `Facts` gains `screens: Vec<Monitor>`, announced **only while the wall takes work** — a wall
  that would refuse a session does not advertise one.
- the host refuses `subscribe` unless it takes work, read fresh, and shows the mark.

## Stages

1. **probe** — `examples/cast-probe.rs`: duplicate each output on the adapter that owns it (this
   laptop is hybrid: the panel is on the Intel iGPU, the RTX 4080 is headless), convert and
   scale on the GPU, encode with the hardware MFT *on that adapter*, write a playable `.h264`,
   and report per-frame capture→encoded latency and bitrate. Also: confirm a window with
   `WDA_EXCLUDEFROMCAPTURE` is absent from the duplicated frame.
2. **local tile** — this laptop on the wall, minus Volery, view only.
3. **across** — another machine's screens over the flyway.
4. **input** — remote keyboard and mouse; local through-the-tile (or step aside).
5. **feel** — glass-to-glass against Parsec on the same machine; native focused presenter if the
   numbers ask; sound; HEVC.
6. **controllers** — later.

## Known limits, said up front

- **Secure desktop.** UAC prompts, the lock screen and Ctrl+Alt+Del are invisible to a
  user-mode capture and refuse injected input; Parsec gets round it with a SYSTEM service. A
  tile shows `locked` (`screen.rs` already knows how to tell) rather than a frozen frame.
- **Relayed paths** cannot carry a 1440p60 stream. See above.
- **One cursor per session** is why local control is through-the-tile-or-step-aside and not
  "exactly like a remote machine".
