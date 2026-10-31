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
