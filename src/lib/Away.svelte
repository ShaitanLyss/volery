<script lang="ts">
  /* The wall with nobody at it.
   *
   * `away.ts` has the rules and `pieces.ts` does the drawing; this holds the
   * frame loop, the hand, and the one piece of chrome — a corner that says how
   * long you have been gone and what is waiting, and the way back.
   *
   * Four decisions worth knowing:
   *
   * **Touching it does not end away mode.** The pieces answer the pointer —
   * that is most of why they are worth having — so a screen that fled on the
   * first click could not be played with at all. The way back is the button or
   * the chord, which is a thing you mean rather than a thing you brush.
   *
   * **It is one canvas per piece, not one canvas.** A canvas cannot change its
   * context kind once it has one, and `tide` is WebGL where the others are 2D.
   * The `{#key}` is the whole of that: a new piece gets a new element, and the
   * old context goes with the old one.
   *
   * **It honours the motion setting.** `motion.ts` exists because a wall that
   * animates costs GPU that a laptop on battery notices, and an away screen
   * runs for hours unattended, which is the worst case that file describes. At
   * `still` the piece draws one frame and stops; at `spare` it runs at a third
   * of the rate. Neither is a special case in the pieces — it is the loop that
   * decides when to call them.
   *
   * **The clock is the wall's own.** `clock.t` already ticks once a second for
   * every card; the corner reads it rather than starting a timer, so an away
   * screen adds exactly one rAF to an idle machine and nothing else. */

  import { onDestroy } from "svelte";

  import { clock } from "./conversation.svelte";
  import { AWAY_SCREENS } from "./presence";
  import {
    awayLine,
    HOLD_MS,
    hueAllowed,
    nextPiece,
    pieceSpec,
    PIECES,
    type PieceId,
  } from "./away";
  import { makePiece, type Env, type Hand, type Piece, type RGB } from "./pieces";
  import { lasted } from "./presence";
  import type { Presence } from "./presence.svelte";

  let {
    presence,
    onback,
  }: {
    presence: Presence;
    /** The way back. Not called by anything the pointer does to a piece. */
    onback: () => void;
  } = $props();

  const screen = $derived(presence.screen);
  const hue = $derived(hueAllowed(screen));

  let id = $state<PieceId>(PIECES[0].id);
  const spec = $derived(pieceSpec(id));

  let host = $state<HTMLDivElement | undefined>();
  let canvas = $state<HTMLCanvasElement | undefined>();

  /** Held down to see the wall, in the `peek` reading. Any key, because the
   *  point is to glance rather than to remember which one. */
  let peeking = $state(false);

  /** The knobs, open.
   *
   *  They live *here* rather than in a settings panel for the reason
   *  `Effects.svelte` gives about the ambience: the whole argument for editing
   *  a backdrop live is that you are looking at the thing you are adjusting,
   *  and a gesture that ends in "now go and find the panel" has already lost.
   *  The one knob that is not about what is on screen — whether a puzzle stands
   *  in the way when you come back — is here too, because it is the same
   *  decision about the same half-hour and splitting it across two surfaces
   *  would be worse than it being slightly out of place. */
  let tuning = $state(false);

  const READINGS: Record<(typeof AWAY_SCREENS)[number], string> = {
    takeover: "cover the wall",
    dimmed: "dim the wall",
    peek: "cover, hold a key to see",
  };

  const line = $derived(
    awayLine(lasted(presence.elapsed(clock.t)), presence.waiting, presence.note),
  );

  /* ── the hand ─────────────────────────────────────────────────────────── */

  const hand: Hand = {
    x: 0,
    y: 0,
    inside: false,
    down: false,
    pressed: false,
    released: false,
    trail: [],
    taps: [],
  };
  /** Where the pointer went down, so a drag can be told from a click. The 4px
   *  slop and the reason for it are the wall's own — see `Canvas.groundDown`;
   *  this is the same rule at a much smaller stake. */
  let downAt: { x: number; y: number } | null = null;

  function at(e: PointerEvent): { x: number; y: number } {
    const r = canvas?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  }

  function onMove(e: PointerEvent) {
    const p = at(e);
    hand.x = p.x;
    hand.y = p.y;
    hand.inside = true;
    hand.trail.push({ x: p.x, y: p.y, t: e.timeStamp });
    /* Bounded by count rather than by age: `flick` walks backwards from the
       end and stops, so a long trail costs memory and buys nothing. */
    if (hand.trail.length > 24) hand.trail.splice(0, hand.trail.length - 24);
  }

  function onDown(e: PointerEvent) {
    const p = at(e);
    hand.x = p.x;
    hand.y = p.y;
    hand.inside = true;
    hand.down = true;
    hand.pressed = true;
    hand.trail = [{ x: p.x, y: p.y, t: e.timeStamp }];
    downAt = p;
    canvas?.setPointerCapture?.(e.pointerId);
  }

  function onUp(e: PointerEvent) {
    const p = at(e);
    hand.x = p.x;
    hand.y = p.y;
    hand.trail.push({ x: p.x, y: p.y, t: e.timeStamp });
    hand.down = false;
    hand.released = true;
    if (downAt && Math.hypot(p.x - downAt.x, p.y - downAt.y) <= 4) {
      hand.taps.push({ x: p.x, y: p.y });
    }
    downAt = null;
    canvas?.releasePointerCapture?.(e.pointerId);
  }

  function onLeave() {
    hand.inside = false;
    hand.down = false;
    downAt = null;
  }

  /* ── the loop ─────────────────────────────────────────────────────────── */

  let piece: Piece | null = null;
  let g: CanvasRenderingContext2D | null = null;
  let gl: WebGL2RenderingContext | null = null;
  let raf = 0;
  let startedAt = 0;
  let lastFrame = 0;
  let sized = { w: 0, h: 0 };
  let tones: { ground: RGB; mark: RGB; faint: RGB } = {
    ground: [15, 13, 12],
    mark: [237, 228, 216],
    faint: [97, 88, 80],
  };
  /** When this piece went up, for the rotation. */
  let since = 0;

  function readTones() {
    if (!host) return;
    const cs = getComputedStyle(host);
    tones = {
      ground: parse(cs.getPropertyValue("--well"), tones.ground),
      mark: parse(cs.getPropertyValue("--paper"), tones.mark),
      faint: parse(cs.getPropertyValue("--paper-faint"), tones.faint),
    };
  }

  /** A token's value as an RGB triple.
   *
   *  The themes are authored as hex (`tokens.css`), but a theme is a diff and
   *  nothing stops one being written in another notation — so a value this
   *  cannot read falls back rather than producing `NaN`, which in a canvas is a
   *  colour that silently draws nothing at all. */
  function parse(v: string, fallback: RGB): RGB {
    const s = v.trim();
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
    if (hex) {
      const h = hex[1];
      const full =
        h.length === 3
          ? h
              .split("")
              .map((c) => c + c)
              .join("")
          : h;
      return [
        parseInt(full.slice(0, 2), 16),
        parseInt(full.slice(2, 4), 16),
        parseInt(full.slice(4, 6), 16),
      ];
    }
    const nums = s.match(/-?\d+(\.\d+)?/g);
    if (nums && nums.length >= 3) {
      const [r, gg, b] = nums.slice(0, 3).map(Number);
      if ([r, gg, b].every(Number.isFinite)) return [r, gg, b];
    }
    return fallback;
  }

  function size() {
    if (!canvas || !host) return;
    const r = host.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(r.width));
    const h = Math.max(1, Math.round(r.height));
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    if (g) g.setTransform(dpr, 0, 0, dpr, 0, 0);
    sized = { w, h };
    piece?.resize(env(0));
  }

  function env(dt: number): Env {
    return {
      w: sized.w,
      h: sized.h,
      t: performance.now() - startedAt,
      dt,
      hue,
      ground: tones.ground,
      mark: tones.mark,
      faint: tones.faint,
    };
  }

  /** How often the loop is allowed to draw, from the motion setting.
   *
   *  Read off the root rather than taking `Motion` as a prop: the attribute is
   *  what every stylesheet in the app already reads, and a second channel for
   *  the same answer is a second thing to keep in step. */
  function pace(): number {
    const m = document.documentElement.dataset.motion;
    if (m === "still") return Infinity;
    if (m === "spare") return 1000 / 20;
    return 0;
  }

  function start() {
    if (!canvas) return;
    /* The setting is off. The screen still stands — see the note in
       `App.svelte` on why — and nothing is built, so there is no context to
       lose and no frame to pay for. */
    if (!presence.animate) return;
    piece = makePiece(id);
    g = null;
    gl = null;
    if (piece.kind === "2d") {
      g = canvas.getContext("2d", { alpha: false });
    } else {
      gl = canvas.getContext("webgl2", { antialias: false, alpha: false });
      if (!gl) {
        /* No WebGL2 — an old driver, a software renderer that refused. Fall
           back rather than showing a black rectangle for nine minutes: the
           screen's whole job is to say the wall is still here. */
        id = "flock";
        return;
      }
    }
    startedAt = performance.now();
    lastFrame = startedAt;
    since = clock.t;
    readTones();
    size();
    /* One frame immediately, so `still` motion still shows something and the
       first frame is not a blank window for however long the next tick is. */
    draw(performance.now());
    if (pace() !== Infinity) raf = requestAnimationFrame(loop);
  }

  function draw(now: number) {
    if (!piece || !sized.w) return;
    const dt = Math.max(0, now - lastFrame);
    lastFrame = now;
    const e = env(dt);
    if (piece.kind === "2d" && g) piece.frame(g, e, hand);
    else if (piece.kind === "webgl2" && gl) piece.frame(gl, e, hand);
    /* Consumed after the piece has seen them, never before: `pressed` and
       `released` are one-frame facts and taps are a queue, and clearing them
       anywhere else is a gesture the piece never hears. */
    hand.pressed = false;
    hand.released = false;
    hand.taps.length = 0;
  }

  function loop(now: number) {
    const floor = pace();
    if (floor === Infinity) {
      raf = 0;
      return;
    }
    if (now - lastFrame >= floor) draw(now);
    raf = requestAnimationFrame(loop);
  }

  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (piece?.kind === "webgl2" && gl) piece.dispose(gl);
    piece = null;
    g = null;
    gl = null;
  }

  /* A new canvas every time the piece changes — see the note at the top. The
     effect's cleanup is what tears the old one down, which is also what runs
     when the screen goes. */
  $effect(() => {
    void id;
    void canvas;
    void presence.animate;
    start();
    return stop;
  });

  /* Rotation, folded onto the wall's own one-second tick rather than given a
     timer. Nothing here polls: `clock.t` is already the only wake-up on an idle
     machine, and this is one comparison on it. */
  $effect(() => {
    if (!presence.animate) return;
    if (clock.t - since < HOLD_MS) return;
    id = nextPiece(id, Math.random());
  });

  $effect(() => {
    if (!host) return;
    const ro = new ResizeObserver(() => size());
    ro.observe(host);
    return () => ro.disconnect();
  });

  /* The theme can change under an away screen — a card is still running, and
     `ink` is a global. Re-read on the tick rather than subscribing: it is three
     `getComputedStyle` reads a second against a frame loop. */
  $effect(() => {
    void clock.t;
    readTones();
  });

  function key(e: KeyboardEvent) {
    /* Escape is the keyboard's way back, and it is the only key that is. Every
       other key *peeks* in the reading that allows it — see `peeking`. */
    if (e.key === "Escape") {
      e.preventDefault();
      onback();
      return;
    }
    if (screen === "peek" && !e.repeat) peeking = true;
  }

  function keyUp() {
    peeking = false;
  }

  onDestroy(stop);
</script>

<svelte:window on:keydown={key} on:keyup={keyUp} />

<div
  class="away"
  class:dimmed={screen === "dimmed"}
  class:peeking={screen === "peek" && peeking}
  bind:this={host}
>
  {#if presence.animate}
    {#key id}
      <canvas
        bind:this={canvas}
        onpointermove={onMove}
        onpointerdown={onDown}
        onpointerup={onUp}
        onpointerleave={onLeave}
        onpointercancel={onLeave}
      ></canvas>
    {/key}
  {/if}

  <div class="corner">
    <span class="head">{line.head}</span>
    {#if line.under}<span class="under">{line.under}</span>{/if}
    <div class="row">
      <button class="back" onclick={onback}>i'm back</button>
      {#if presence.animate}
        <button
          class="piece"
          title={spec.about}
          onclick={() => {
            id = nextPiece(id, Math.random());
          }}>{spec.label}</button
        >
      {/if}
      <button
        class="more"
        class:on={tuning}
        title="How the wall behaves while you are away"
        aria-label="away settings"
        onclick={() => (tuning = !tuning)}>&middot;&middot;&middot;</button
      >
    </div>
    {#if tuning}
      <div class="knobs">
        <span class="what">{presence.animate ? spec.about : "nothing is drawn while you are away"}</span>
        <div class="line">
          {#each AWAY_SCREENS as s (s)}
            <button
              class="chip"
              class:on={screen === s}
              onclick={() => presence.setScreen(s)}>{READINGS[s]}</button
            >
          {/each}
        </div>
        <div class="line">
          <button
            class="chip"
            class:on={presence.animate}
            onclick={() => presence.setAnimate(!presence.animate)}
            >{presence.animate ? "animating" : "still"}</button
          >
          <button
            class="chip"
            class:on={presence.toys}
            title="A short puzzle between you and the wall when you come back — a word, a derivative, a shape to turn, something to draw"
            onclick={() => presence.setToys(!presence.toys)}
            >{presence.toys ? "puzzle on the way back" : "no puzzle"}</button
          >
        </div>
      </div>
    {:else if screen === "peek"}
      <span class="hint">hold any key to see the wall</span>
    {/if}
  </div>
</div>

<style>
  /* Every screen, its chrome on the home one — `Rest.svelte`'s arrangement and
     its reasoning. Spread over several monitors the studio root is the
     containing block for anything fixed, so `inset: 0` would cover all of them
     and centre the corner between two. All four offsets are zero when nothing
     is spread. See `span.ts`. */
  .away {
    position: fixed;
    left: calc(-1 * var(--span-x, 0px));
    top: calc(-1 * var(--span-y, 0px));
    width: 100vw;
    height: 100vh;
    box-sizing: border-box;
    /* Above the rest screen, which is the only other thing in this app allowed
       to cover the window: a break you are not here to take is not a break. */
    z-index: 9500;
    overflow: hidden;
    background: var(--well);
    /* Slow, like a light going down in a room. The same figure the rest screen
       arrives on, and for the same reason: a full-window layer that snapped in
       would read as an error. */
    animation: dusk 1.4s cubic-bezier(0.22, 0.68, 0.24, 1) both;
    transition: opacity 260ms ease;
  }

  /* The reading that leaves the wall legible behind it. The piece draws
     hueless here — see `away.ts::hueAllowed`, which is the house rule about
     colour being kept rather than bent. */
  .away.dimmed {
    background: color-mix(in srgb, var(--well) 86%, transparent);
    backdrop-filter: blur(3px) saturate(0.8);
  }
  .away.dimmed canvas {
    opacity: 0.78;
  }

  /* Holding a key in the `peek` reading. The layer fades rather than being
     removed, so the piece goes on running and the hand goes on being tracked —
     letting go puts you back exactly where you were. */
  .away.peeking {
    opacity: 0.08;
    pointer-events: none;
  }

  @keyframes dusk {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  canvas {
    display: block;
    position: absolute;
    inset: 0;
    touch-action: none;
  }

  /* Bottom-left rather than centred. The middle is where the piece is, and a
     plate over it would be the one thing you cannot move out of the way. */
  .corner {
    position: absolute;
    left: calc(var(--span-x, 0px) + 2.2rem);
    bottom: calc(var(--span-b, 0px) + 2rem);
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    pointer-events: none;
  }

  .head {
    font-family: var(--display);
    font-size: 1.5rem;
    color: var(--paper);
    opacity: 0.82;
  }
  .under {
    font-family: var(--util);
    font-size: 0.68rem;
    letter-spacing: 0.1em;
    color: var(--paper-mute);
  }
  .hint {
    font-family: var(--util);
    font-size: 0.58rem;
    letter-spacing: 0.1em;
    color: var(--paper-faint);
  }

  .row {
    display: flex;
    gap: 0.4rem;
    margin-top: 0.35rem;
    pointer-events: auto;
  }

  button {
    font-family: var(--util);
    font-size: 0.62rem;
    letter-spacing: 0.12em;
    border: 1px solid color-mix(in srgb, var(--paper) 22%, transparent);
    border-radius: 3px;
    background: color-mix(in srgb, var(--paper) 6%, transparent);
    color: var(--paper-dim);
    cursor: pointer;
    padding: 0.3rem 0.65rem;
    transition:
      color 160ms ease,
      border-color 160ms ease;
  }
  button:hover {
    color: var(--paper);
    border-color: color-mix(in srgb, var(--paper) 45%, transparent);
  }
  .back {
    color: var(--paper);
  }
  .more {
    letter-spacing: 0;
    padding: 0.3rem 0.5rem;
  }

  .knobs {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin-top: 0.4rem;
    pointer-events: auto;
    max-width: 24rem;
  }
  .what {
    font-family: var(--util);
    font-size: 0.58rem;
    letter-spacing: 0.1em;
    color: var(--paper-faint);
  }
  .line {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
  }
  .chip {
    font-size: 0.58rem;
    padding: 0.22rem 0.5rem;
  }
  .chip.on {
    color: var(--paper);
    border-color: color-mix(in srgb, var(--paper) 45%, transparent);
  }
</style>
