<script lang="ts">
  /* The strands, painted.
   *
   * One canvas in screen space and a frame loop that does nothing but call into
   * `flow.ts` — where the curve is, how far the braid is twisted this
   * millisecond, which pulses are still on the wire, when a strand is over.
   * Nothing here decides anything you could assert; that is all next door.
   *
   * Five things about it are deliberate, and four of them are the same four
   * `Backdrop.svelte` states one layer down:
   *
   * - **Screen space, not canvas space.** A strand has to reach a card on the
   *   wall and a card stuck to the glass, and screen space is the only frame
   *   those two share. It also means a strand keeps its width at every zoom,
   *   which is the point: zoomed out to see the whole studio is exactly when
   *   you want to see who is talking to whom.
   *
   * - **The loop stops when nothing is flying.** `Flights.sweep` decides, and
   *   an empty wall runs no frames at all.
   *
   * - **Endpoints are read fresh every frame, untracked.** A card dragged while
   *   a message is crossing to it takes the light with it, and the pan does the
   *   same — the strand is between two *cards*, not between two points that
   *   were true 900ms ago.
   *
   * - **Colour is status, so there is exactly one here**: celadon, `--st-work`,
   *   because a message in flight is work moving between two cards. Read off the
   *   document with the ground beside it, so a derived theme gets both the tone
   *   and the compositing right with nobody remembering this file.
   *
   * - **Nothing is drawn under a card, only up to it.** `rimPoint` starts the
   *   light at the card's edge; the canvas sits above the wall and below the
   *   glass, so a strand crosses the ground and never a transcript.
   */

  import {
    FILAMENTS,
    PULSES,
    arrival,
    bowOf,
    clampInto,
    controls,
    departure,
    filamentSamples,
    filamentTone,
    paletteFor,
    pulseAt,
    rimPoint,
    stillAlpha,
    tone,
    wakeAlpha,
    type Box,
    type Palette,
    type Pt,
  } from "./flow";
  import { skin } from "./palette.svelte";
  import type { Flights } from "./relay.svelte";

  let {
    flights,
    boxes,
    pane,
  }: {
    flights: Flights;
    /** Every card's box in screen pixels, by conversation id. Rebuilt by
     *  `Canvas` as the wall moves; read untracked in the frame. */
    boxes: Map<string, Box>;
    /** The pane's size, for pulling an off-screen endpoint back to the edge. */
    pane: { w: number; h: number };
  } = $props();

  let el = $state<HTMLCanvasElement | undefined>();
  let w = 0;
  let h = 0;
  let palette: Palette = paletteFor("#7fb8a4", "#151210");
  /* Read once at mount rather than per frame: `matchMedia` is cheap and this is
     not, but the honest reason is that a preference changing mid-flight should
     not change how the strand already on the wall behaves. */
  let still = false;

  function measure() {
    const parent = el?.parentElement;
    if (!el || !parent) return;
    const dpr = window.devicePixelRatio || 1;
    w = parent.clientWidth;
    h = parent.clientHeight;
    el.width = Math.max(1, Math.round(w * dpr));
    el.height = Math.max(1, Math.round(h * dpr));
    const ctx = el.getContext("2d");
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function readTokens() {
    if (!el) return;
    const cs = getComputedStyle(el);
    palette = paletteFor(
      cs.getPropertyValue("--st-work").trim(),
      cs.getPropertyValue("--ink").trim(),
    );
  }

  $effect(() => {
    const parent = el?.parentElement;
    if (!parent) return;
    measure();
    still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    /* The parent, never the canvas: observing a box you resize is the feedback
       loop `Backdrop.svelte` records reaching twenty-two million pixels. */
    const ro = new ResizeObserver(() => measure());
    ro.observe(parent);
    return () => ro.disconnect();
  });

  /* The tone and the ground are re-read whenever the skin repaints the root, so a
     strand flying after a skin change is drawn in that skin's celadon and
     composited for its ground. A canvas cannot see a custom property change.
     Nothing is owed a redraw: the frame reads `palette` every frame, and a strand
     already in the air simply changes colour for its last second. */
  $effect(() => {
    void skin.painted;
    if (!el) return;
    readTokens();
  });

  /* ── the loop ─────────────────────────────────────────────────────────── */

  let raf = 0;

  /* A boolean rather than the list, so the effect re-runs when the wall goes
     quiet or wakes and not on every strand added or swept. Tracking the array
     itself would tear the loop down and build it again on each frame that
     retires one. */
  const flying = $derived(flights.all.length > 0);

  $effect(() => {
    if (flying) start();
    else stop();
    return stop;
  });

  function start() {
    if (raf) return;
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    const ctx = el?.getContext("2d");
    if (ctx && w && h) ctx.clearRect(0, 0, w, h);
  }

  function frame() {
    const ctx = el?.getContext("2d");
    if (!ctx) {
      raf = 0;
      return;
    }
    const now = Date.now();
    ctx.clearRect(0, 0, w, h);

    /* Untracked on purpose — see the note at the top. A frame is not a
       reaction, and reading `boxes` reactively here would re-run this effect
       on every pan tick as well as scheduling the next frame. */
    const live = flights.all;
    const where = boxes;
    const view = pane;

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (palette.additive) ctx.globalCompositeOperation = "lighter";

    for (const f of live) {
      const age = now - f.at;
      if (age < 0) continue;
      const from = where.get(f.from);
      const to = where.get(f.to);
      /* A card closed mid-flight. Nothing to draw between, and inventing a
         point would draw a strand from somewhere nothing is. */
      if (!from || !to) continue;

      const a0 = rimPoint(from, { x: to.x + to.w / 2, y: to.y + to.h / 2 });
      const b0 = rimPoint(to, { x: from.x + from.w / 2, y: from.y + from.h / 2 });
      const a = clampInto(a0, view);
      const b = clampInto(b0, view);
      const bow = bowOf(a.pt, b.pt, f.fan);
      const [c1, c2] = controls(a.pt, b.pt, bow);

      if (still) drawStill(ctx, a.pt, c1, c2, b.pt, age);
      else drawLive(ctx, a.pt, c1, c2, b.pt, age, f.delivered, a.beyond, b.beyond);
    }

    ctx.restore();

    /* Swept after drawing, so a strand is drawn on the frame it finishes on
       rather than vanishing one frame early. */
    if (flights.sweep(now)) raf = requestAnimationFrame(frame);
    else raf = 0;
  }

  /* ── one strand ───────────────────────────────────────────────────────── */

  function drawLive(
    ctx: CanvasRenderingContext2D,
    a: Pt,
    c1: Pt,
    c2: Pt,
    b: Pt,
    age: number,
    delivered: boolean,
    aBeyond: boolean,
    bBeyond: boolean,
  ) {
    const wake = wakeAlpha(age);

    for (let fi = 0; fi < FILAMENTS.length; fi += 1) {
      const fil = FILAMENTS[fi];
      const colour = filamentTone(palette, fi);

      /* The wake: the route showing faintly behind the light, per thread, so
         the braid is legible even where no pulse is on it. This is what stops a
         strand reading as a wire — it is only there while something is. */
      if (wake > 0) {
        strokeRun(
          ctx,
          filamentSamples(a, c1, c2, b, 0, 1, fi, age, 40),
          tone(colour, wake * 0.09 * fil.alpha),
          1 * fil.width,
        );
      }

      for (let p = 0; p < PULSES; p += 1) {
        const at = pulseAt(age, p, fi);
        if (!at) continue;
        /* The trailing pulses are fainter, so the strand reads as one thing
           passing rather than three things chasing each other. */
        const strength = (1 - p * 0.28) * fil.alpha;
        const pts = filamentSamples(a, c1, c2, b, at.tail, at.head, fi, age, 16);
        taperedRun(ctx, pts, colour, strength, fil.width, aBeyond, bBeyond, at);
      }
    }

    const out = departure(age);
    if (out && !aBeyond) ring(ctx, a, out.radius, out.alpha, palette.core);
    for (const r of arrival(age, delivered)) {
      if (!bBeyond) ring(ctx, b, r.radius, r.alpha, palette.core);
    }
  }

  /** Reduced motion: the same curve and the same braid, held and faded.
   *
   *  Deliberately not "draw nothing". What a strand says is *who told whom*,
   *  and none of that is in the movement — a message arriving with no mark
   *  anywhere on the wall is a worse answer than a line that does not move. */
  function drawStill(
    ctx: CanvasRenderingContext2D,
    a: Pt,
    c1: Pt,
    c2: Pt,
    b: Pt,
    age: number,
  ) {
    const alpha = stillAlpha(age);
    if (alpha <= 0) return;
    for (let fi = 0; fi < FILAMENTS.length; fi += 1) {
      strokeRun(
        ctx,
        /* Frozen at the moment it set off, so the braid does not turn. */
        filamentSamples(a, c1, c2, b, 0, 1, fi, 0, 40),
        tone(filamentTone(palette, fi), alpha * 0.5 * FILAMENTS[fi].alpha),
        1.4 * FILAMENTS[fi].width,
      );
    }
  }

  function strokeRun(
    ctx: CanvasRenderingContext2D,
    pts: Pt[],
    colour: string,
    width: number,
  ) {
    if (pts.length < 2) return;
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  }

  /** One pulse: bright and thick at the head, nothing at the tail.
   *
   *  Stroked segment by segment rather than as one path with a gradient. A
   *  canvas gradient is defined between two *points*, and this is a curve that
   *  doubles back on itself — the braid guarantees it — so a two-point gradient
   *  would run its ramp along the chord instead of along the thread and put the
   *  bright end in the middle of a bend. Sixteen short strokes is the honest
   *  way and is not measurably slower at this length.
   *
   *  `shadowBlur` is what makes it read as light rather than as paint. Set on
   *  the head segments only: it is the expensive part of a canvas stroke, and
   *  the tail is too faint for the bloom to be visible anyway. */
  function taperedRun(
    ctx: CanvasRenderingContext2D,
    pts: Pt[],
    colour: [number, number, number],
    strength: number,
    width: number,
    aBeyond: boolean,
    bBeyond: boolean,
    at: { head: number; tail: number },
  ) {
    if (pts.length < 2) return;
    const n = pts.length - 1;
    for (let i = 0; i < n; i += 1) {
      /* 0 at the tail, 1 at the head. Squared, so the light is concentrated in
         the leading fifth rather than spread evenly down the smear. */
      const t = (i + 1) / n;
      const lead = t * t;
      /* A strand whose endpoint is off the pane is pulled to the edge; fading
         the last of it out is what keeps that from reading as a line stopping
         dead against nothing. */
      const edge =
        (aBeyond ? clamp01((at.tail + (at.head - at.tail) * t) * 4) : 1) *
        (bBeyond ? clamp01((1 - (at.tail + (at.head - at.tail) * t)) * 4) : 1);
      const alpha = strength * lead * 0.85 * edge;
      if (alpha <= 0.004) continue;
      ctx.shadowBlur = lead > 0.7 ? 10 * width : 0;
      ctx.shadowColor = lead > 0.7 ? tone(colour, alpha * 0.7) : "transparent";
      ctx.strokeStyle = tone(colour, alpha);
      ctx.lineWidth = Math.max(0.5, (0.6 + 1.9 * lead) * width);
      ctx.beginPath();
      ctx.moveTo(pts[i].x, pts[i].y);
      ctx.lineTo(pts[i + 1].x, pts[i + 1].y);
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";
  }

  function ring(
    ctx: CanvasRenderingContext2D,
    at: Pt,
    radius: number,
    alpha: number,
    colour: [number, number, number],
  ) {
    if (alpha <= 0.004 || radius <= 0) return;
    ctx.strokeStyle = tone(colour, alpha);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(at.x, at.y, radius, 0, Math.PI * 2);
    ctx.stroke();
  }

  function clamp01(v: number): number {
    return Math.min(1, Math.max(0, v));
  }
</script>

<canvas class="flow" bind:this={el} aria-hidden="true"></canvas>

<style>
  /* Above the wall and below the glass (`z-index: 4`), so a strand crosses the
     ground and the cards standing on it but never something stuck to the pane
     — which is the same order the wall itself is drawn in.

     A sibling of `.surface` rather than a child of it: `.surface` clips at the
     transcript panel's left edge, and a card stuck to the glass over the
     transcript is a perfectly good endpoint. Pinned to 100% rather than
     measured from itself, per `measure()`. */
  .flow {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    z-index: 3;
    pointer-events: none;
  }
</style>
